/**
 * @fileoverview Custom Model Endpoint Profiles CRUD + discovery
 * (docs/custom-model-endpoints-plan.md). Endpoints are machine-level infra,
 * like remote/docker hosts, so writes are admin-only in multi-user mode
 * (`case-routes.ts`'s `/api/remote-hosts` is the pattern this mirrors).
 *
 * Discovery (`POST /:id/discover-models`) fetches `${baseUrl}/v1/models`
 * through `webviewFetch()` (`webview-egress.ts`), the same guarded dispatcher
 * the web-tab proxy uses: `baseUrl` is refused at save time by the schema's
 * hostname check (link-local / cloud-metadata literals and names), and the
 * undici lookup hook refuses a name that RESOLVES into one of those ranges at
 * connect time, redirects included — a save-time hostname check alone would
 * let `models.example` resolve to 169.254.169.254 later. The endpoint is
 * admin-configured, so this is defence in depth rather than the only gate.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { isAdmin, parseBody } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getDataDir } from '../../config/instance.js';
import { isBlockedWebviewUrl } from '../webview-egress-policy.js';
import { egressBlockedReason, webviewFetch } from '../webview-egress.js';
import { CustomModelHostSchema } from '../schemas.js';
import { readCustomModelHosts, writeCustomModelHosts, type CustomModelHost } from '../../custom-model-hosts.js';

const CODEMAN_CONFIG_DIR = getDataDir();
const DISCOVER_TIMEOUT_MS = 8000;

function adminOnly(req: FastifyRequest, reply: { code: (n: number) => unknown }): ApiResponse<never> | null {
  if (!isMultiUserMode() || isAdmin(req)) return null;
  reply.code(403);
  return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
}

/**
 * `defaultModelId` names the model the Run-menu picker applies for this endpoint with
 * no further choice, so it must actually be one of the discovered `models` — a schema
 * `.refine()` can't see across the two fields the way this can, and would also run on
 * every unrelated field edit rather than only when either of these two changes.
 */
function invalidDefaultModel(host: Pick<CustomModelHost, 'defaultModelId' | 'models'>): ApiResponse<never> | null {
  if (host.defaultModelId === undefined) return null;
  if ((host.models ?? []).includes(host.defaultModelId)) return null;
  return createErrorResponse(
    ApiErrorCode.INVALID_INPUT,
    'defaultModelId must be one of the endpoint’s discovered models'
  );
}

async function discoverModels(host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>): Promise<string[]> {
  const headers: Record<string, string> = {};
  const apiKey = host.apiKey?.trim();
  // Exactly ONE header, never both — see custom-model-hosts.ts's CustomModelAuthStyle
  // doc comment for why: sending both reliably HANGS some real servers.
  const style = host.authStyle ?? 'bearer';
  if (apiKey && style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (apiKey && style === 'api-key') headers['api-key'] = apiKey;

  const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/v1/models`), {
    headers,
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * undici reports every network failure as `TypeError('fetch failed', { cause })`, with the
 * useful part (`connect ECONNREFUSED 127.0.0.1:8080`) one level down; surface the deepest
 * message so the user sees the refused connection, not the wrapper.
 */
function describeFetchError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
    if (current instanceof Error && current.message) message = current.message;
  }
  return message;
}

export function registerCustomModelRoutes(app: FastifyInstance): void {
  app.get('/api/model-endpoints', async (req) =>
    isMultiUserMode() && !isAdmin(req) ? [] : readCustomModelHosts(CODEMAN_CONFIG_DIR)
  );

  app.post('/api/model-endpoints', async (req, reply): Promise<ApiResponse<{ host: CustomModelHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(CustomModelHostSchema, req.body);
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const badDefault = invalidDefaultModel(host);
    if (badDefault) return badDefault;
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Model endpoint already exists');
    }
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host } };
  });

  app.put('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ host: CustomModelHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const host = parseBody(CustomModelHostSchema, { ...(req.body as object), id });
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const badDefault = invalidDefaultModel(host);
    if (badDefault) return badDefault;
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
    const next = [...hosts];
    next[index] = host;
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host } };
  });

  app.delete('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    await writeCustomModelHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/model-endpoints/:id/discover-models',
    async (req, reply): Promise<ApiResponse<{ models: string[] }>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { id } = req.params as { id: string };
      const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
      const index = hosts.findIndex((item) => item.id === id);
      if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
      const host = hosts[index];
      if (isBlockedWebviewUrl(host.baseUrl)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
      }
      try {
        const models = await discoverModels(host);
        const next = [...hosts];
        // A default that no longer appears in the fresh list would leave the Run-menu
        // picker applying a model id the endpoint just told us it doesn't serve; drop
        // it rather than carry it forward silently invalid.
        const defaultModelId =
          host.defaultModelId && models.includes(host.defaultModelId) ? host.defaultModelId : undefined;
        next[index] = { ...host, models, defaultModelId, lastDiscoveredAt: new Date().toISOString() };
        await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
        return { success: true, data: { models } };
      } catch (err) {
        const blocked = egressBlockedReason(err);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          blocked ? `Endpoint refused: ${blocked}` : `Could not reach endpoint: ${describeFetchError(err)}`
        );
      }
    }
  );
}
