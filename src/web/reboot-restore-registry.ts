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
 * - One restore runs at a time per owner. `beginSpending()` single-flights the
 *   route, so two concurrent clicks cannot interleave pane creation for the same
 *   user, while two different users never block each other.
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
  /**
   * Per owner, bumped by anything that invalidates that owner's entries while a
   * restore is already holding them. A Dismiss arriving mid-restore must win:
   * without this the route's `finally` would put its unspent entries back and
   * resurrect the offer the user just cleared, with a fresh 24-hour life.
   *
   * Keyed by owner rather than global, because `clear()` is ownership-scoped. A
   * single counter would let one user's Dismiss discard another user's unspent
   * entries, and the plan is in-memory, so those offers would be gone for good.
   */
  private generations = new Map<string | undefined, number>();
  /**
   * Owners with a restore in flight, between its take and its last pane.
   * Keyed by owner so one user's restore does not turn another user's click into
   * a conflict; `take()` already guarantees no two callers get the same entry.
   * Single-user mode has one key, `undefined`, so it behaves as one global flight.
   */
  private spending = new Set<string | undefined>();

  /** Replace the plan with what the boot pass found. An empty list clears it. */
  set(entries: readonly RebootRestoreEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.sessionId, entry]));
    this.builtAt = entries.length > 0 ? Date.now() : 0;
    this.bumpAll();
  }

  /**
   * The generations of the owners of `entries`, for a caller that will hand some
   * of them back later. Pass the result to {@link restore}.
   */
  snapshotGenerations(entries: readonly RebootRestoreEntry[]): Map<string | undefined, number> {
    const snapshot = new Map<string | undefined, number>();
    for (const entry of entries) snapshot.set(entry.owner, this.generations.get(entry.owner) ?? 0);
    return snapshot;
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
   * Used for the click-time rejections that may resolve themselves: a workspace
   * that comes back, a capacity limit the user makes room under, a CLI that
   * starts once its binary is on the PATH. A conversation the user resumed by
   * hand is NOT put back, because that one cannot stop being true, and an entry
   * the banner keeps re-offering forever is noise only Dismiss can clear.
   */
  restore(entries: readonly RebootRestoreEntry[], generations?: ReadonlyMap<string | undefined, number>): void {
    let added = 0;
    for (const entry of entries) {
      // A dismiss (or a fresh boot plan) for THIS entry's owner since the caller
      // took it means it is no longer wanted back. Another owner's dismiss is
      // none of this entry's business.
      if (generations) {
        const taken = generations.get(entry.owner);
        if (taken !== undefined && taken !== (this.generations.get(entry.owner) ?? 0)) continue;
      }
      this.entries.set(entry.sessionId, entry);
      added += 1;
    }
    if (added > 0 && this.builtAt === 0) this.builtAt = Date.now();
  }

  /** Drop the entries a viewer can see. Returns how many went. */
  clear(canAccess: (owner: string | undefined) => boolean): number {
    const removable = [...this.entries.values()].filter((entry) => canAccess(entry.owner));
    for (const entry of removable) this.entries.delete(entry.sessionId);
    if (this.entries.size === 0) this.builtAt = 0;
    // A restore in flight for these owners must not put their entries back. The
    // in-flight owners are the ones that matter and the ones the plan can no
    // longer name: `take()` has already removed their entries, so a dismiss that
    // lands mid-restore sees nothing of theirs to remove. The bump is limited to
    // owners this caller could see, so it cannot reach anyone else's restore.
    const invalidated = new Set(removable.map((entry) => entry.owner));
    for (const owner of this.spending) if (canAccess(owner)) invalidated.add(owner);
    for (const owner of invalidated) this.bump(owner);
    return removable.length;
  }

  /**
   * Claim the right to run a restore for one owner, or report that owner already
   * has one running. Callers that get `true` must call `endSpending()` in a
   * `finally` with the same owner.
   */
  beginSpending(owner?: string): boolean {
    if (this.spending.has(owner)) return false;
    this.spending.add(owner);
    return true;
  }

  endSpending(owner?: string): void {
    this.spending.delete(owner);
  }

  /** Test hook: forget everything, including the single-flight claim. */
  reset(): void {
    this.entries.clear();
    this.builtAt = 0;
    this.spending.clear();
    this.generations.clear();
  }

  private bump(owner: string | undefined): void {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1);
  }

  /** Invalidate every owner's in-flight returns, including owners not yet seen. */
  private bumpAll(): void {
    for (const owner of new Set([...this.entries.values()].map((entry) => entry.owner))) this.bump(owner);
    for (const owner of [...this.generations.keys()]) this.bump(owner);
  }

  private dropIfExpired(): void {
    if (this.builtAt > 0 && Date.now() - this.builtAt > PLAN_TTL_MS) {
      // Bump before clearing, while the owners are still known: a restore that
      // took entries just before the expiry must not hand them back afterwards
      // and give an expired plan another full day of life.
      this.bumpAll();
      this.entries.clear();
      this.builtAt = 0;
    }
  }
}

/** Process-wide singleton, mirroring `approvalInbox`. */
export const rebootRestoreRegistry = new RebootRestoreRegistry();
