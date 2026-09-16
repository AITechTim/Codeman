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
   * Re-apply the persisted state a freshly CONSTRUCTED session does not carry:
   * the pin, token and cost totals, auto-compact, auto-clear, auto-resume, nice
   * priority, the flicker filter and the custom-model selection.
   *
   * A `Session` built from a record holds only what its constructor takes, so
   * persisting it would otherwise REPLACE the fuller record with the reduced one.
   * Call this before the first persist, and before `startInteractive()`, because
   * the custom-model selection has to reach the pane's environment.
   */
  reapplyPersistedSessionState(session: Session, saved: SessionState): Promise<void>;
  getSessionStateWithRespawn(session: Session): unknown;
}
