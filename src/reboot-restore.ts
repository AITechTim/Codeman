/**
 * @fileoverview Decide which sessions a host reboot destroyed and may be rebuilt.
 *
 * A server restart and a host reboot both leave `reconcileSessions()` reporting
 * dead sessions, and they need opposite handling. A server restart leaves the
 * tmux panes running, so recovery ATTACHES to them. A host reboot takes the tmux
 * server down with it, so there is nothing to attach to and the pane has to be
 * created again. This module holds the decision half of that second case, kept
 * free of tmux and disk access so it can be unit tested without either. Every
 * observation it reads is gathered by the caller and passed in.
 *
 * "Eligible" here means a session the user did not end on purpose. The rule that
 * an intentional kill or detach is never auto-revived is enforced at runtime by
 * an in-memory guard in `TmuxManager`, and memory does not survive a reboot. The
 * durable equivalent is the record `cleanupSession()` leaves behind. An unpinned
 * kill deletes the record outright, so it is already absent here. A pinned kill
 * goes through `demoteOrRemoveSession()` and lands as `status: 'stopped'`, which
 * is the marker this module refuses. Pruning keeps a pinned record WITHOUT
 * touching its status, so a pinned session a reboot killed still reads `idle` or
 * `busy` and stays eligible.
 *
 * @dependencies types (SessionState), config/cli-registry
 * @consumedby web/server (plan build at boot), web/routes/reboot-restore-routes
 *
 * @module reboot-restore
 */

import type { SessionState } from './types.js';
import { getCli } from './config/cli-registry/registry.js';

/** Session statuses a reboot restore may rebuild. `stopped` is the kill marker. */
const RESTORABLE_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'error']);

/** Observations the reboot heuristic reads. Gathered by the caller, never here. */
export interface RebootEvidence {
  /** Sessions that still had a live pane during reconciliation. */
  livePaneCount: number;
  /** Sessions reconciliation just marked dead. */
  deadSessionCount: number;
  /** `os.uptime()`, in seconds. */
  uptimeSeconds: number;
  /** Newest `lastActivityAt` across the persisted records, in ms since the epoch. */
  newestPersistedActivityAt: number;
  /** `Date.now()` when the evidence was gathered, in ms. */
  now: number;
}

/**
 * Decide whether the machine plausibly rebooted rather than the server restarting.
 *
 * Two signals have to agree. The socket must hold no panes at all while state
 * still lists sessions, which rules out an ordinary server restart. The host
 * must also have booted after the newest persisted session activity, which is
 * the corroboration `os.uptime()` provides cheaply. A wiped tmux socket on a
 * long-uptime host fails the second test, so a user who killed the tmux server
 * by hand does not get every session offered back to them.
 *
 * This heuristic decides whether to ASK, never whether to act. A wrong yes costs
 * the user a banner they dismiss, because the restore itself waits for a click.
 */
export function looksLikeHostReboot(evidence: RebootEvidence): boolean {
  if (evidence.deadSessionCount === 0) return false;
  if (evidence.livePaneCount > 0) return false;
  if (evidence.newestPersistedActivityAt <= 0) return false;
  const bootedAt = evidence.now - evidence.uptimeSeconds * 1000;
  return bootedAt > evidence.newestPersistedActivityAt;
}

/**
 * Pick the conversation the rebuilt pane should resume.
 *
 * The chain's tail is the newest conversation the session was holding, which is
 * what a compact or a clear leaves behind; `resumeSessionId` covers a session
 * that was itself started as a resume, and the session id is the original
 * conversation for everything else.
 */
export function resolveResumeConversationId(state: SessionState): string {
  const chain = state.claudeSessionChain;
  const chainTail = Array.isArray(chain) && chain.length > 0 ? chain[chain.length - 1] : undefined;
  return chainTail || state.resumeSessionId || state.id;
}

/** Why one session was passed over. Reported for logging and assertions. */
export interface RebootRestoreRejection {
  sessionId: string;
  reason:
    | 'no-persisted-record'
    | 'intentionally-ended'
    | 'respawn-blocked'
    | 'remote-or-docker'
    | 'unsupported-mode'
    | 'no-working-dir'
    | 'workspace-missing'
    | 'already-live';
}

/** One restorable session, as the banner shows it and the rebuild replays it. */
export interface RebootRestoreEntry {
  sessionId: string;
  name?: string;
  workingDir: string;
  owner?: string;
  mode: string;
  /** The conversation the rebuilt pane resumes. */
  resumeConversationId: string;
  /**
   * The persisted record, kept whole so the rebuild can replay what it held.
   * Read at boot, before pruning deletes it, and held in memory until the click.
   */
  state: SessionState;
}

export interface RebootRestorePlan {
  restore: RebootRestoreEntry[];
  skipped: RebootRestoreRejection[];
}

/**
 * Split the sessions reconciliation just killed into the ones a reboot restore
 * may offer and the ones it must leave alone.
 *
 * @param deadSessionIds Session ids `reconcileSessions()` reported as dead.
 * @param persisted The `state.json` session records, which `cleanupStaleSessions()`
 *   has not pruned yet at the point this runs.
 * @param workspaceExists Whether a working directory is still on disk. A tmux
 *   session can outlive its deleted repo, and rebuilding one there would scaffold
 *   an empty tree. The caller owns the disk access; the click re-checks, because
 *   a repo can be deleted between the boot and the click.
 */
export function planRebootRestore(
  deadSessionIds: readonly string[],
  persisted: Readonly<Record<string, SessionState>>,
  workspaceExists: (workingDir: string) => boolean
): RebootRestorePlan {
  const restore: RebootRestoreEntry[] = [];
  const skipped: RebootRestoreRejection[] = [];

  for (const sessionId of deadSessionIds) {
    const state = persisted[sessionId];
    if (!state) {
      // An unpinned kill already deleted the record, so absence IS the guard.
      skipped.push({ sessionId, reason: 'no-persisted-record' });
      continue;
    }
    if (!RESTORABLE_STATUSES.has(state.status)) {
      // A pinned kill was demoted to `stopped`. Reviving it would undo the kill.
      skipped.push({ sessionId, reason: 'intentionally-ended' });
      continue;
    }
    if (state.respawnBlocked === true) {
      // The crash-loop breaker tripped on this pane. Re-creating it restarts the loop.
      skipped.push({ sessionId, reason: 'respawn-blocked' });
      continue;
    }
    if (state.remote || state.docker) {
      // Both need another host or a container to be up, which a just-booted machine
      // cannot promise. The remote reconnect watcher owns the remote case already.
      skipped.push({ sessionId, reason: 'remote-or-docker' });
      continue;
    }
    // Capability, not a CLI id: this pass resumes by handing the CLI a conversation
    // id through the top-level `resumeSessionId`, which only a CLI whose history the
    // claude-jsonl reader understands can consume that way. Others carry their thread
    // id in their own `<Mode>Config`, which this pass does not thread through.
    if (getCli(state.mode ?? 'claude')?.capabilities.transcript !== 'claude-jsonl') {
      skipped.push({ sessionId, reason: 'unsupported-mode' });
      continue;
    }
    if (!state.workingDir) {
      skipped.push({ sessionId, reason: 'no-working-dir' });
      continue;
    }
    if (!workspaceExists(state.workingDir)) {
      skipped.push({ sessionId, reason: 'workspace-missing' });
      continue;
    }
    restore.push({
      sessionId,
      name: state.name,
      workingDir: state.workingDir,
      owner: state.owner,
      mode: state.mode ?? 'claude',
      resumeConversationId: resolveResumeConversationId(state),
      state,
    });
  }

  return { restore, skipped };
}

/**
 * Drop the entries whose conversation is already on screen.
 *
 * Hours can pass between the boot that built the plan and the click that spends
 * it, and the Resume list can reach the same conversation in the meantime. Two
 * panes running `claude --resume` on one conversation is the failure this
 * prevents, so a match on either the session id or the conversation id is enough
 * to skip the entry.
 */
export function rejectAlreadyLive(
  entries: readonly RebootRestoreEntry[],
  liveSessionIds: ReadonlySet<string>,
  liveConversationIds: ReadonlySet<string>
): RebootRestorePlan {
  const restore: RebootRestoreEntry[] = [];
  const skipped: RebootRestoreRejection[] = [];
  for (const entry of entries) {
    if (liveSessionIds.has(entry.sessionId) || liveConversationIds.has(entry.resumeConversationId)) {
      skipped.push({ sessionId: entry.sessionId, reason: 'already-live' });
      continue;
    }
    restore.push(entry);
  }
  return { restore, skipped };
}

/** Newest `lastActivityAt` across persisted records, or 0 when there are none. */
export function newestPersistedActivity(persisted: Readonly<Record<string, SessionState>>): number {
  let newest = 0;
  for (const state of Object.values(persisted)) {
    const stamp = state.lastActivityAt ?? state.createdAt ?? 0;
    if (stamp > newest) newest = stamp;
  }
  return newest;
}
