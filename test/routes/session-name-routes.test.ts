/**
 * @fileoverview PUT /api/sessions/:id/name hands the name to the user (#376).
 *
 * A rename flips `nameSource` to `manual`, persists it and broadcasts it, so
 * auto-naming can never overwrite a name a person chose, on this server or
 * on the one that restores the session after a restart.
 *
 * Uses app.inject() — no real HTTP ports needed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { Session } from '../../src/session.js';
import { SseEvent } from '../../src/web/sse-events.js';

describe('PUT /api/sessions/:id/name', () => {
  let harness: RouteTestHarness;
  let session: Session;
  const updateSessionName = vi.fn(() => true);

  beforeAll(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
    // A REAL session, since the ownership flag lives on the class, not the mock.
    session = new Session({ id: 'name-route-test', workingDir: '/tmp', name: 'w1-demo' });
    harness.ctx.sessions.set(session.id, session as never);
    (harness.ctx.mux as Record<string, unknown>).updateSessionName = updateSessionName;
  });

  afterAll(async () => {
    await harness.app.close();
  });

  it('flips a placeholder to manual, then persists and broadcasts the ownership', async () => {
    expect(session.nameSource).toBe('placeholder');

    const res = await harness.app.inject({
      method: 'PUT',
      url: `/api/sessions/${session.id}/name`,
      payload: { name: 'my window' },
    });

    expect(res.statusCode).toBe(200);
    // The harness registers the bare route; the {success,data} envelope is a server-level hook.
    expect(res.json()).toMatchObject({ name: 'my window' });
    expect(session.name).toBe('my window');
    expect(session.nameSource).toBe('manual');
    expect(session.applyAutoName('w1-demo: fix it')).toBe(false);
    expect(session.name).toBe('my window');

    expect(updateSessionName).toHaveBeenCalledWith(session.id, 'my window');
    expect(harness.ctx.persistSessionState).toHaveBeenCalledWith(session);
    expect(harness.ctx.broadcast).toHaveBeenCalledWith(
      SseEvent.SessionUpdated,
      expect.objectContaining({ id: session.id, name: 'my window', nameSource: 'manual' })
    );
    // What the restore path will read back: the persisted state carries the flag.
    expect(session.toState().nameSource).toBe('manual');
  });
});
