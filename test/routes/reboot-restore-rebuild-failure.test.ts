/**
 * Reboot-restore route: what happens when a rebuild gets part-way and then fails.
 *
 * The other route test file deliberately uses workspaces that do not exist, so it
 * never reaches `new Session()`. This one mocks the `Session` module so the route
 * runs its whole construction path — `addSession`, `setupSessionListeners`,
 * `reapplyPersistedSessionState`, `startInteractive` — and then throws where a
 * real one would when the CLI binary is missing from a freshly booted machine's
 * PATH. Without the mock there is no way to exercise that path, which is how the
 * original version of this route shipped a session leak the tests could not see.
 *
 * It also covers the session caps, because those too are only reachable once the
 * route is actually willing to build something.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

/** Set per test: whether the mocked `startInteractive()` rejects. */
let startShouldThrow = false;

vi.mock('../../src/session.js', () => ({
  Session: class {
    id: string;
    mode: string;
    name?: string;
    workingDir: string;
    owner?: string;
    claudeSessionId: string | null = null;
    constructor(config: { id: string; mode?: string; name?: string; workingDir: string; owner?: string }) {
      this.id = config.id;
      this.mode = config.mode ?? 'claude';
      this.name = config.name;
      this.workingDir = config.workingDir;
      this.owner = config.owner;
    }
    async startInteractive() {
      if (startShouldThrow) throw new Error('spawn claude ENOENT');
    }
    /** The mock route context projects a session through this on broadcast. */
    toState() {
      return { id: this.id, mode: this.mode, name: this.name, workingDir: this.workingDir, owner: this.owner };
    }
  },
}));

const { registerRebootRestoreRoutes } = await import('../../src/web/routes/reboot-restore-routes.js');
const { rebootRestoreRegistry } = await import('../../src/web/reboot-restore-registry.js');
const { installRouteErrorHandler } = await import('../../src/web/route-error-handler.js');
const { httpStatusForErrorCode } = await import('../../src/types.js');
const { createMockRouteContext } = await import('../mocks/index.js');
type ApiErrorCode = import('../../src/types.js').ApiErrorCode;
type RebootRestoreEntry = import('../../src/reboot-restore.js').RebootRestoreEntry;
type SessionState = import('../../src/types.js').SessionState;

/** A real directory, so the route's workspace checks pass and it reaches the build. */
const WORKSPACE = process.cwd();

function offerEntry(sessionId: string, owner?: string): RebootRestoreEntry {
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: WORKSPACE,
    owner,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: null,
      status: 'idle',
      workingDir: WORKSPACE,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      owner,
    } as SessionState,
  };
}

async function createHarness(ctx: ReturnType<typeof createMockRouteContext>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  registerRebootRestoreRoutes(app, ctx as never);
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });
  installRouteErrorHandler(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  startShouldThrow = false;
});

afterEach(() => {
  rebootRestoreRegistry.reset();
  vi.clearAllMocks();
});

describe('a rebuild that fails after the session is registered', () => {
  it('reports why it failed rather than blaming the workspace', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    // Not `workspace-missing`: the directory is there, the agent would not start.
    expect(res.skipped).toEqual([{ sessionId: 'a', reason: 'rebuild-failed' }]);
    await app.close();
  });

  it('does not leave a registered session with no pane behind it', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    // The session reached ctx.sessions via addSession; the route has to take it
    // back out, or the board shows a tab whose pane never existed.
    expect(ctx.cleanupSession).toHaveBeenCalledWith('a', true, expect.any(String));
    await app.close();
  });

  it('keeps the entry on offer, so the user can fix the PATH and click again', async () => {
    startShouldThrow = true;
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });
});

describe('a rebuild that succeeds', () => {
  it('re-applies the persisted state before the record is written again', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored.map((s: { id: string }) => s.id)).toEqual(['a']);
    // A session built from a record carries none of the pin, token totals or
    // custom-model selection, so persisting it first would replace the fuller
    // record with the reduced one.
    expect(ctx.reapplyPersistedSessionState).toHaveBeenCalled();
    const reapplyOrder = (ctx.reapplyPersistedSessionState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const persistOrder = (ctx.persistSessionState as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(reapplyOrder).toBeLessThan(persistOrder);
    await app.close();
  });

  it('tells every other board about the rebuilt session', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(ctx.broadcast).toHaveBeenCalledWith('session:created', expect.anything());
    await app.close();
  });

  it('spends the entry, so it is no longer on offer', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    const app = await createHarness(ctx);

    await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions).toEqual([]);
    await app.close();
  });
});

describe('the session caps', () => {
  it('stops restoring at the global cap and leaves the rest on offer', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const ctx = createMockRouteContext({ workspaceHooksEnabled: false });
    // Fill the board to the documented maximum of 50 concurrent sessions.
    for (let i = 0; i < 50; i += 1) {
      ctx.sessions.set(`filler-${i}`, { id: `filler-${i}`, owner: undefined } as never);
    }
    const app = await createHarness(ctx);

    const res = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(res.restored).toEqual([]);
    expect(res.skipped.map((s: { reason: string }) => s.reason)).toEqual(['capacity-reached', 'capacity-reached']);

    // Refused rather than lost: closing a session and clicking again works.
    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id).sort()).toEqual(['a', 'b']);
    await app.close();
  });
});
