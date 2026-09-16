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
const PROPS_TIMEOUT_MS = 5000;

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

/**
 * Never hand the stored credential back to the browser, on GET, POST or PUT
 * alike — the file is written 0600 precisely because it holds one. `apiKeySet`
 * is what lets the editor say "unchanged if left blank" without the client
 * ever holding the real value: `applyStoredApiKey()` below is the other half,
 * treating an absent key on PUT as "keep the stored one" rather than clearing
 * it, which is what makes never returning it survivable for the edit flow.
 */
function redactApiKey(host: CustomModelHost): Omit<CustomModelHost, 'apiKey'> & { apiKeySet: boolean } {
  const { apiKey, ...rest } = host;
  return { ...rest, apiKeySet: !!apiKey };
}

/**
 * A PUT body with no `apiKey` (or a blank one) means "leave it alone", never
 * "clear it": the editor never receives the real value to resend deliberately
 * unchanged (see redactApiKey), so the only way it can tell the two apart is
 * by omission. There is deliberately no way to CLEAR a key back to unset this
 * way — a pre-existing limitation, not something this changes.
 */
function applyStoredApiKey(incoming: CustomModelHost, existing: CustomModelHost): CustomModelHost {
  return incoming.apiKey ? incoming : { ...incoming, apiKey: existing.apiKey };
}

function authHeaders(host: Pick<CustomModelHost, 'apiKey' | 'authStyle'>): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = host.apiKey?.trim();
  // Exactly ONE header, never both — see custom-model-hosts.ts's CustomModelAuthStyle
  // doc comment for why: sending both reliably HANGS some real servers.
  const style = host.authStyle ?? 'bearer';
  if (apiKey && style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (apiKey && style === 'api-key') headers['api-key'] = apiKey;
  return headers;
}

export interface DiscoveryResult {
  models: string[];
  /** See `CustomModelHost.modelContextLengths` — only ever populated for models already loaded. */
  contextLengths: Record<string, number>;
}

/**
 * Best-effort: fetches `GET /props?model=<id>` (llama.cpp-native, llama-swap-proxied) for
 * ONE already-loaded model and pulls its real `n_ctx` out. Never called for a model that
 * isn't already loaded — see the caller and `CustomModelHost.modelContextLengths` for why
 * that's a hard safety requirement, not just a nicety: llama-swap treats this endpoint's
 * `?model=` as a routing hint, and asking it about an unloaded model risks triggering an
 * actual (slow, GPU-swapping) load as a side effect of what should be read-only discovery.
 * Any failure (unreachable, non-2xx, missing/malformed field) is swallowed — one model's
 * context length is a nice-to-have, never worth failing the whole discovery pass over.
 */
async function fetchContextLength(
  host: Pick<CustomModelHost, 'baseUrl'>,
  modelId: string,
  headers: Record<string, string>
): Promise<number | undefined> {
  try {
    const url = new URL(`${host.baseUrl.replace(/\/+$/, '')}/props`);
    url.searchParams.set('model', modelId);
    const res = await webviewFetch(url, { headers, signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
    const nCtx = body.n_ctx ?? body.default_generation_settings?.n_ctx;
    return typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0 ? nCtx : undefined;
  } catch {
    return undefined;
  }
}

async function discoverModels(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>
): Promise<DiscoveryResult> {
  const headers = authHeaders(host);
  const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/v1/models`), {
    headers,
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown; status?: { value?: unknown } }> };
  const entries = body.data ?? [];
  const models = entries.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  // llama-swap-specific, feature-detected: a server that never mentions `status` on ANY
  // entry gets no context-length enrichment at all, rather than treating "no status field"
  // as "assume unloaded" — either reading is a guess, and skipping is the safe one, since
  // fetchContextLength must only ever run against a model this server itself calls loaded.
  const hasStatusField = entries.some((m) => m && typeof m === 'object' && 'status' in m);
  const contextLengths: Record<string, number> = {};
  if (hasStatusField) {
    const loadedIds = entries
      .filter((m) => m.status && typeof m.status === 'object' && (m.status as { value?: unknown }).value === 'loaded')
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    for (const id of loadedIds) {
      const ctx = await fetchContextLength(host, id, headers);
      if (ctx !== undefined) contextLengths[id] = ctx;
    }
  }
  return { models, contextLengths };
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

type RedactedHost = ReturnType<typeof redactApiKey>;

/**
 * Merges a fresh `GET /v1/models` result into a host record: stamps
 * `lastDiscoveredAt`, and drops `defaultModelId` if it no longer appears in
 * the fresh list (it would otherwise leave the Run-menu picker applying a
 * model id the endpoint just told us it doesn't serve). Pure — no IO, so the
 * manual route (which reports a fetch failure's *reason* to the caller) and
 * the periodic sweep below (which only cares whether it can move on) can
 * each do their own `discoverModels()` + error handling around one shared
 * "how to apply a successful result" step.
 */
function applyDiscoveredModels(host: CustomModelHost, result: DiscoveryResult): CustomModelHost {
  const { models, contextLengths } = result;
  const defaultModelId = host.defaultModelId && models.includes(host.defaultModelId) ? host.defaultModelId : undefined;
  // Merge onto what's already known rather than replacing: a model not probed this round
  // (not currently loaded) keeps whatever context length an earlier round already learned
  // for it, and one no longer in the fresh list is dropped, same reasoning as defaultModelId.
  const merged = { ...host.modelContextLengths, ...contextLengths };
  const kept = Object.fromEntries(Object.entries(merged).filter(([id]) => models.includes(id)));
  const modelContextLengths = Object.keys(kept).length > 0 ? kept : undefined;
  return { ...host, models, defaultModelId, modelContextLengths, lastDiscoveredAt: new Date().toISOString() };
}

/**
 * Re-discovers every saved endpoint's models, best-effort. One endpoint being
 * unreachable (powered off, wrong network) must not stop the others from
 * refreshing, and a read-modify-write per host (rather than one batch write
 * at the end) means a crash or restart mid-sweep loses at most the endpoints
 * not yet reached, never a write already applied. Exported so both the
 * periodic timer (server.ts) and a test can drive it directly.
 */
export async function refreshAllCustomModelHosts(): Promise<void> {
  const dataDir = getDataDir();
  const hosts = await readCustomModelHosts(dataDir);
  for (const host of hosts) {
    if (isBlockedWebviewUrl(host.baseUrl)) continue;
    let result: DiscoveryResult;
    try {
      result = await discoverModels(host);
    } catch {
      continue; // unreachable this cycle — try again next tick, not fatal to the sweep
    }
    // Re-read + splice by id rather than reusing the array captured above: an
    // admin editing or deleting an endpoint via the API mid-sweep must win,
    // not be silently overwritten by a refresh that started before their change.
    const current = await readCustomModelHosts(dataDir);
    const index = current.findIndex((item) => item.id === host.id);
    if (index === -1) continue; // deleted mid-sweep
    current[index] = applyDiscoveredModels(current[index], result);
    await writeCustomModelHosts(dataDir, current);
  }
}

export function registerCustomModelRoutes(app: FastifyInstance): void {
  app.get('/api/model-endpoints', async (req): Promise<RedactedHost[]> => {
    if (isMultiUserMode() && !isAdmin(req)) return [];
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    return hosts.map(redactApiKey);
  });

  app.post('/api/model-endpoints', async (req, reply): Promise<ApiResponse<{ host: RedactedHost }>> => {
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
    return { success: true, data: { host: redactApiKey(host) } };
  });

  app.put('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ host: RedactedHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const incoming = parseBody(CustomModelHostSchema, { ...(req.body as object), id });
    if (isBlockedWebviewUrl(incoming.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const badDefault = invalidDefaultModel(incoming);
    if (badDefault) return badDefault;
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
    const host = applyStoredApiKey(incoming, hosts[index]);
    const next = [...hosts];
    next[index] = host;
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host: redactApiKey(host) } };
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
        const result = await discoverModels(host);
        const next = [...hosts];
        next[index] = applyDiscoveredModels(host, result);
        await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
        return { success: true, data: { models: result.models } };
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
