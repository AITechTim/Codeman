/**
 * Reboot-restore route tests (src/web/routes/reboot-restore-routes.ts) via
 * app.inject(), no live port.
 *
 * Every entry these tests put on offer names a workspace that does not exist, so
 * the route's click-time workspace check rejects it before any `Session` is
 * constructed. That keeps the tests on the route's own guards — taking, scoping,
 * single-flighting and re-checking — and leaves pane creation to
 * test/reboot-restore.test.ts, which drives a real `Session` for it.
 *
 * The routes read the process-wide `rebootRestoreRegistry` singleton, so every
 * test resets it; a leaked entry would bleed into the next one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { registerRebootRestoreRoutes } from '../../src/web/routes/reboot-restore-routes.js';
import { rebootRestoreRegistry } from '../../src/web/reboot-restore-registry.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { httpStatusForErrorCode, type ApiErrorCode } from '../../src/types.js';
import { createMockRouteContext } from '../mocks/index.js';
import type { RebootRestoreEntry } from '../../src/reboot-restore.js';
import type { SessionState } from '../../src/types.js';

async function createHarness(authUser?: { username: string; role: 'admin' | 'user' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (authUser) {
    app.addHook('onRequest', async (req) => {
      (req as unknown as { authUser: typeof authUser }).authUser = authUser;
    });
  }
  registerRebootRestoreRoutes(app, createMockRouteContext() as never);

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

/** An entry whose workspace is deliberately absent, so no pane is ever created. */
function offerEntry(sessionId: string, owner?: string): RebootRestoreEntry {
  return {
    sessionId,
    name: `session ${sessionId}`,
    workingDir: `/tmp/codeman-reboot-restore-missing/${sessionId}`,
    owner,
    mode: 'claude',
    resumeConversationId: `conv-${sessionId}`,
    state: {
      id: sessionId,
      pid: null,
      status: 'idle',
      workingDir: `/tmp/codeman-reboot-restore-missing/${sessionId}`,
      currentTaskId: null,
      createdAt: 1_760_000_000_000,
      mode: 'claude',
      owner,
    } as SessionState,
  };
}

afterEach(() => {
  rebootRestoreRegistry.reset();
});

describe('GET /api/reboot-restore', () => {
  it('reports nothing when no reboot left anything behind', async () => {
    const app = await createHarness();
    const res = await app.inject({ method: 'GET', url: '/api/reboot-restore' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.sessions).toEqual([]);
    await app.close();
  });

  it('names what is on offer, and says the scrollback is not coming back', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();
    const body = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(body.sessions.map((s: { id: string }) => s.id)).toEqual(['a', 'b']);
    expect(body.scrollbackRestored).toBe(false);
    await app.close();
  });

  it('never carries the persisted record itself to the browser', async () => {
    rebootRestoreRegistry.set([offerEntry('a', 'alice')]);
    const app = await createHarness({ username: 'alice', role: 'admin' });
    const body = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(Object.keys(body.sessions[0]).sort()).toEqual(['id', 'mode', 'name', 'owner', 'workingDir']);
    expect(body.sessions[0].state).toBeUndefined();
    await app.close();
  });
});

describe('POST /api/reboot-restore/restore', () => {
  it('spends the offer, so a second click finds nothing left to spend', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    const app = await createHarness();

    const first = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    // The workspace is gone, so nothing was rebuilt — but the entry was taken.
    expect(first.restored).toEqual([]);
    expect(first.skipped).toEqual([{ sessionId: 'a', reason: 'workspace-missing' }]);

    const second = (await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} })).json().data;
    expect(second.restored).toEqual([]);
    expect(second.skipped).toEqual([]);
    await app.close();
  });

  it('spends only the sessions the click named', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/api/reboot-restore/restore',
      payload: { sessionIds: ['b'] },
    });
    expect(res.json().data.skipped).toEqual([{ sessionId: 'b', reason: 'workspace-missing' }]);

    const left = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(left.sessions.map((s: { id: string }) => s.id)).toEqual(['a']);
    await app.close();
  });

  it('refuses a body it does not recognise rather than guessing', async () => {
    const app = await createHarness();
    const res = await app.inject({
      method: 'POST',
      url: '/api/reboot-restore/restore',
      payload: { sessionIds: 'not-an-array' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    await app.close();
  });

  it('turns a second concurrent restore away rather than interleaving it', async () => {
    rebootRestoreRegistry.set([offerEntry('a')]);
    // Claimed by a restore already in flight.
    expect(rebootRestoreRegistry.beginSpending()).toBe(true);
    const app = await createHarness();
    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/restore', payload: {} });
    expect(res.statusCode).toBe(409);
    rebootRestoreRegistry.endSpending();
    await app.close();
  });
});

describe('POST /api/reboot-restore/dismiss', () => {
  it('drops the offer and leaves the banner with nothing to show', async () => {
    rebootRestoreRegistry.set([offerEntry('a'), offerEntry('b')]);
    const app = await createHarness();

    const res = await app.inject({ method: 'POST', url: '/api/reboot-restore/dismiss', payload: {} });
    expect(res.json().data.dismissed).toBe(2);

    const after = (await app.inject({ method: 'GET', url: '/api/reboot-restore' })).json().data;
    expect(after.sessions).toEqual([]);
    await app.close();
  });
});
