/**
 * @fileoverview Session port — capabilities for session lifecycle management.
 * Route modules that manage sessions depend on this port.
 */

import type { Session } from '../../session.js';
import type { SessionState } from '../../types.js';

export interface SessionPort {
  readonly sessions: ReadonlyMap<string, Session>;
  addSession(session: Session): Promise<void>;
  cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  persistSessionState(session: Session): void;
  persistSessionStateNow(session: Session): void;
  /**
   * Re-apply the persisted state a freshly CONSTRUCTED session does not carry.
   *
   * A `Session` built from a record holds only what its constructor takes, so
   * persisting it would otherwise REPLACE the fuller record with the reduced one.
   * Two phases: `before-spawn` shapes the pane (the custom-model environment and
   * the nice priority) and must precede `startInteractive()`; `after-spawn` is
   * the session's own history (the pin, token and cost totals, auto-compact,
   * auto-clear, auto-resume, colour, image watcher, flicker filter) and must NOT
   * land on a session whose pane failed to start.
   */
  reapplyPersistedSessionState(
    session: Session,
    saved: SessionState,
    phase: 'before-spawn' | 'after-spawn'
  ): Promise<void>;
  /**
   * Undo a session that was registered but never got a working pane: the map
   * entry, its tab-layout slot, and any pane the launch created before throwing.
   * Unlike {@link cleanupSession} it leaves the persisted record, the lifetime
   * token totals, the Ralph state and the workspace's own files untouched.
   */
  discardPartiallyBuiltSession(sessionId: string): Promise<void>;
  getSessionStateWithRespawn(session: Session): unknown;
}
