/**
 * @fileoverview The pending restore plan: what a host reboot destroyed, waiting on a click.
 *
 * The boot pass builds this plan inside `restoreMuxSessions()`, in the window
 * where reconciliation has reported the dead sessions and `cleanupStaleSessions()`
 * has not pruned their records yet. The board then offers "restore N sessions
 * from before the reboot", and `web/routes/reboot-restore-routes` spends the plan
 * when the user clicks.
 *
 * Invariants:
 * - Entries are in-memory only. A server restart drops the plan, and nothing
 *   re-builds it, because the records it was built from are pruned by then.
 *   That costs the convenience this feature adds and never the conversation:
 *   the conversation IS the transcript under `~/.claude/projects`, which
 *   `services/unified-session-service.ts` reads for the Welcome screen's Resume
 *   list and the Session Manager, and `resumeHistorySession()` in
 *   `web/public/terminal-ui.js` resumes from a row there with no persisted
 *   session record involved. A dropped plan therefore returns the user to
 *   resuming by hand, one at a time, which is where they are without this
 *   feature. What the plan held that a transcript does not is the owner, the
 *   name, the env overrides, the effort and the lineage.
 * - Module-level singleton in the style of `web/approval-inbox.ts`: no `Session`
 *   import and no IO, which keeps it unit-testable and cycle-free.
 * - Spending is take-then-build: `take()` removes entries synchronously, before
 *   the route's first `await`, so a double-click or two devices cannot both
 *   reach the same entry and put two panes on one conversation.
 * - One restore runs at a time. `beginSpending()` single-flights the route, so
 *   two concurrent clicks cannot interleave pane creation.
 *
 * @dependencies reboot-restore (RebootRestoreEntry)
 * @consumedby web/server (plan build at boot), web/routes/reboot-restore-routes
 *
 * @module web/reboot-restore-registry
 */

import type { RebootRestoreEntry } from '../reboot-restore.js';

/**
 * A plan older than this is dropped on read. A machine that rebooted yesterday
 * has moved on, and an offer nobody took by then is noise rather than a rescue.
 */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

export class RebootRestoreRegistry {
  /** Keyed by session id, in the order the boot pass found them. */
  private entries = new Map<string, RebootRestoreEntry>();
  /** When the boot pass built the plan, in ms since the epoch. */
  private builtAt = 0;
  /** True while a restore route call is between its take and its last pane. */
  private spending = false;

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    this.builtAt = entries.length > 0 ? Date.now() : 0;
  }

  /**
   * The entries a viewer may see, newest plan first-come order preserved.
   *
   * @param canAccess Ownership predicate, so a user sees their own entries and
   *   an admin sees all. Applied here rather than in the route so the count the
   *   banner shows and the entries a click spends come from one filter.
   */
  list(canAccess: (owner: string | undefined) => boolean): RebootRestoreEntry[] {
    this.dropIfExpired();
    return [...this.entries.values()].filter((entry) => canAccess(entry.owner));
  }

  /**
   * Remove and return the entries a click is about to spend.
   *
   * Synchronous and total: an entry leaves the plan here, before any pane is
   * created, so a second click finds nothing to spend. Entries a caller may not
   * access are left in place, and unknown ids are ignored.
   *
   * @param sessionIds The ids to spend, or undefined for every visible entry.
   */
  take(canAccess: (owner: string | undefined) => boolean, sessionIds?: readonly string[]): RebootRestoreEntry[] {
    this.dropIfExpired();
    const wanted = sessionIds ? new Set(sessionIds) : undefined;
    const taken: RebootRestoreEntry[] = [];
    for (const entry of [...this.entries.values()]) {
      if (wanted && !wanted.has(entry.sessionId)) continue;
      if (!canAccess(entry.owner)) continue;
      this.entries.delete(entry.sessionId);
      taken.push(entry);
    }
    return taken;
  }

  /**
   * Put entries back after a rebuild never got as far as creating a pane.
   *
   * Used for the click-time rejections, so a conversation the user resumed by
   * hand meanwhile does not silently vanish from the banner while a workspace
   * that came back stays offered.
   */
  restore(entries: readonly RebootRestoreEntry[]): void {
    for (const entry of entries) this.entries.set(entry.sessionId, entry);
    if (entries.length > 0 && this.builtAt === 0) this.builtAt = Date.now();
  }

  /** Drop the entries a viewer can see. Returns how many went. */
  clear(canAccess: (owner: string | undefined) => boolean): number {
    const removable = [...this.entries.values()].filter((entry) => canAccess(entry.owner));
    for (const entry of removable) this.entries.delete(entry.sessionId);
    if (this.entries.size === 0) this.builtAt = 0;
    return removable.length;
  }

  /**
   * Claim the right to run a restore, or report that one is already running.
   * Callers that get `true` must call `endSpending()` in a `finally`.
   */
  beginSpending(): boolean {
    if (this.spending) return false;
    this.spending = true;
    return true;
  }

  endSpending(): void {
    this.spending = false;
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.entries.clear();
    this.builtAt = 0;
    this.spending = false;
  }

  private dropIfExpired(): void {
    if (this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS) {
      this.entries.clear();
      this.builtAt = 0;
    }
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
