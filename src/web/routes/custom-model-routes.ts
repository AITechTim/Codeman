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
  /** See `CustomModelHost.modelSizesGB` — populated for every model whose own listing states one. */
  sizesGB: Record<string, number>;
}

/**
 * Best-effort: pulls a file size in GB out of a model's own `description`, when the
 * server states one. llama-swap writes `"Auto-discovered 16.35 GB - parameters
 * auto-fitted by llama.cpp"` for a model it found on disk itself; a hand-configured
 * profile's own description (e.g. `"General-purpose reasoning model, MoE CPU-offloaded."`)
 * has no such figure and correctly yields no estimate rather than a guess — there is no
 * separate "give me the file size" endpoint to fall back on.
 */
function parseSizeGB(description: unknown): number | undefined {
  if (typeof description !== 'string') return undefined;
  const match = /(\d+(?:\.\d+)?)\s*GB\b/i.exec(description);
  if (!match) return undefined;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : undefined;
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
 *
 * ⚠️ FALLBACK ONLY — confirmed live to be actively WRONG for a `--fit-ctx`-launched llama-
 * swap backend: `/props`'s `n_ctx` read 154112 for a model llama-swap itself had launched
 * with `--fit-ctx 16384` (visible in `/running`'s own `cmd`), and the real server then
 * refused a request at the real 16384-token limit — `n_ctx` here appears to report the
 * model's theoretical/trained maximum, not the runtime-configured one. `parseCtxFromCmd`
 * (below), which reads the actual launch flag `/running` reports, is the primary source;
 * this is only used when that parse comes up empty (no recognized flag in `cmd`, or `cmd`
 * itself unavailable).
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

/**
 * Parses the REAL configured context size out of llama-swap's own launch command for a
 * model (`/running`'s `cmd` field, e.g. `"llama-server -m ... --fit-ctx 16384 ..."`) —
 * the primary source for `modelContextLengths`, preferred over `/props`'s `n_ctx` (see
 * `fetchContextLength`'s own doc comment for why that field is unreliable here). Checks
 * `--fit-ctx` first (llama-swap's own auto-fit flag), then the plain llama.cpp
 * `-c`/`--ctx-size`/`--ctx_size` flags a hand-written launch command might use instead.
 * Returns `undefined` when `cmd` has none of these — not every launch command needs to
 * state one explicitly (llama.cpp has its own default), and guessing one would be worse
 * than the "no override applied" the caller already treats an unknown length as.
 */
function parseCtxFromCmd(cmd: unknown): number | undefined {
  if (typeof cmd !== 'string') return undefined;
  const match = /--fit-ctx\s+(\d+)/.exec(cmd) ?? /(?:^|\s)(?:-c|--ctx-size|--ctx_size)\s+(\d+)/.exec(cmd);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
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
  const body = (await res.json()) as {
    data?: Array<{ id?: unknown; status?: { value?: unknown }; description?: unknown }>;
  };
  const entries = body.data ?? [];
  const models = entries.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  const sizesGB: Record<string, number> = {};
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const size = parseSizeGB(entry.description);
    if (size !== undefined) sizesGB[entry.id] = size;
  }

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
    if (loadedIds.length > 0) {
      // Primary source: the REAL launch command (see parseCtxFromCmd's own doc comment
      // for why /props's n_ctx cannot be trusted here). One /running call covers every
      // loaded model, so this never costs more requests than the old /props-only path did
      // when the cmd parse succeeds, and exactly one extra when it has to fall back.
      const swapStatus = await getLlamaSwapStatus(host);
      const cmdById = new Map(swapStatus.running.map((r) => [r.model, r.cmd]));
      for (const id of loadedIds) {
        const fromCmd = parseCtxFromCmd(cmdById.get(id));
        const ctx = fromCmd ?? (await fetchContextLength(host, id, headers));
        if (ctx !== undefined) contextLengths[id] = ctx;
      }
    }
  }
  return { models, contextLengths, sizesGB };
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
const RUNNING_TIMEOUT_MS = 5000;

export interface LlamaSwapRunningModel {
  model: string;
  state: string;
  /** The actual launch command llama-swap started this backend with, when it says one —
   *  see `parseCtxFromCmd`, which reads the real configured context size out of this. */
  cmd?: string;
}

export interface LlamaSwapStatus {
  /**
   * Feature-detected via `GET /running`: true only when the server answered with
   * llama-swap's own shape (`{ running: [...] }`). Plain llama.cpp (and any other
   * OpenAI-compatible server) has no such endpoint and always runs the single model
   * it was started with, so there is no "current model" to conflict with — every
   * caller must treat `isLlamaSwap: false` as "nothing to check", never as an error.
   */
  isLlamaSwap: boolean;
  running: LlamaSwapRunningModel[];
}

/**
 * Distinguishes llama-swap from a plain llama.cpp/OpenAI-compatible server, and reports
 * what llama-swap currently has loaded — llama.cpp only ever runs one GGUF at a time, and
 * llama-swap unloads/reloads it on demand when a request asks for a different one, which
 * can take anywhere from a few seconds to over a minute. Read-only: this never triggers a
 * swap itself (unlike `/props?model=`, `/running` takes no `model` parameter to route by).
 * Best-effort like `discoverModels()`'s siblings: any failure (unreachable, non-2xx,
 * unexpected shape) reads as "not llama-swap", never thrown.
 */
export async function getLlamaSwapStatus(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>
): Promise<LlamaSwapStatus> {
  try {
    const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/running`), {
      headers: authHeaders(host),
      signal: AbortSignal.timeout(RUNNING_TIMEOUT_MS),
    });
    if (!res.ok) return { isLlamaSwap: false, running: [] };
    const body = (await res.json()) as { running?: unknown };
    if (!Array.isArray(body.running)) return { isLlamaSwap: false, running: [] };
    const running = body.running
      .filter(
        (r): r is { model: string; state?: unknown; cmd?: unknown } =>
          !!r && typeof r === 'object' && typeof (r as { model?: unknown }).model === 'string'
      )
      .map((r) => ({
        model: r.model,
        state: typeof r.state === 'string' ? r.state : 'unknown',
        cmd: typeof r.cmd === 'string' ? r.cmd : undefined,
      }));
    return { isLlamaSwap: true, running };
  } catch {
    return { isLlamaSwap: false, running: [] };
  }
}

/**
 * Actually kicks off llama-swap's lazy model load, rather than waiting for the launched
 * CLI's own first prompt to do it. llama-swap has no separate "switch model" admin
 * endpoint — the ONLY thing that starts a swap is a real inference request naming the
 * model (confirmed live: applying a selection alone never appeared in the llama-swap
 * server's own logs; nothing had actually asked it to load anything). This sends the
 * smallest real request that will — `max_tokens: 1`, one throwaway user message — to
 * `${baseUrl}/v1/chat/completions`, the OpenAI-compatible endpoint every supported
 * harness already points at.
 *
 * Deliberately fire-and-forget: the caller (the apply/create routes) returns to the
 * client immediately, and the frontend's own polling (`GET .../running-status`) is what
 * actually confirms readiness — this call's response is never read, just its side
 * effect. No abort/timeout of its own either: a real load can take well over a minute for
 * a large model, and this is a normal long-running Node process, so there is nothing to
 * clean up by cutting it short. Errors are swallowed for the same reason `discoverModels`'s
 * siblings swallow theirs — one endpoint's hiccup here is a nice-to-have that failed, not
 * something worth surfacing as a request failure four layers up.
 */
export function triggerLlamaSwapLoad(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>,
  modelId: string
): void {
  const url = new URL(`${host.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`);
  webviewFetch(url, {
    method: 'POST',
    headers: { ...authHeaders(host), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
      stream: false,
    }),
  }).catch(() => {
    // best-effort — see the doc comment above
  });
}

function applyDiscoveredModels(host: CustomModelHost, result: DiscoveryResult): CustomModelHost {
  const { models, contextLengths, sizesGB } = result;
  const defaultModelId = host.defaultModelId && models.includes(host.defaultModelId) ? host.defaultModelId : undefined;
  // Merge onto what's already known rather than replacing: a model not probed this round
  // (not currently loaded) keeps whatever context length an earlier round already learned
  // for it, and one no longer in the fresh list is dropped, same reasoning as defaultModelId.
  const merged = { ...host.modelContextLengths, ...contextLengths };
  const kept = Object.fromEntries(Object.entries(merged).filter(([id]) => models.includes(id)));
  const modelContextLengths = Object.keys(kept).length > 0 ? kept : undefined;
  // sizesGB, unlike contextLengths, is populated for every model in the SAME pass (no
  // loaded-only restriction — see parseSizeGB), so this is closer to a plain replace, but
  // still merges onto the previous round rather than dropping a size for a model whose
  // description happened to omit the figure on this particular pass.
  const mergedSizes = { ...host.modelSizesGB, ...sizesGB };
  const keptSizes = Object.fromEntries(Object.entries(mergedSizes).filter(([id]) => models.includes(id)));
  const modelSizesGB = Object.keys(keptSizes).length > 0 ? keptSizes : undefined;
  return {
    ...host,
    models,
    defaultModelId,
    modelContextLengths,
    modelSizesGB,
    lastDiscoveredAt: new Date().toISOString(),
  };
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

  // Read-only, no admin gate: any session owner who can already point their own session
  // at this endpoint (POST .../custom-model, ungated by design — see session-routes.ts)
  // can equally ask what it currently has loaded, before or while that apply is pending.
  app.get('/api/model-endpoints/:id/running-status', async (req): Promise<ApiResponse<LlamaSwapStatus>> => {
    const { id } = req.params as { id: string };
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    const host = hosts.find((item) => item.id === id);
    if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    return { success: true, data: await getLlamaSwapStatus(host) };
  });
}
