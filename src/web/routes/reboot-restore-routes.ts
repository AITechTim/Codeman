/**
 * @fileoverview Reboot-restore routes: offer back the sessions a host reboot destroyed.
 *
 * The boot pass leaves a plan in `web/reboot-restore-registry` when the machine
 * plausibly rebooted. The board reads it, shows a banner, and the user decides:
 * - `GET  /api/reboot-restore`: what is on offer, ownership-scoped
 * - `POST /api/reboot-restore/restore`: rebuild some or all of it
 * - `POST /api/reboot-restore/dismiss`: drop the offer
 *
 * A click, not the heuristic, is what creates panes. The heuristic only decides
 * whether the banner appears, so a wrong yes costs a line of text the user
 * dismisses rather than N CLI processes nobody asked for.
 *
 * Rebuilding is take-then-build: entries leave the plan synchronously at the top
 * of the route, before the first `await`, and the whole route is single-flighted,
 * so a double-click or two devices cannot put two panes on one conversation.
 * Three things are re-checked at click time rather than trusted from boot: the
 * owner's privilege grant, the workspace still being on disk, and the
 * conversation not already being live because the user resumed it by hand.
 *
 * A rebuilt session comes back attached, idle and disarmed. Respawn controllers
 * and Ralph loops are deliberately not re-armed, and its terminal scrollback is
 * gone, because the pane is new. The banner says so.
 */

import { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import { ApiErrorCode, createErrorResponse, getErrorMessage } from '../../types.js';
import { RebootRestoreRequestSchema } from '../schemas.js';
import {
  parseBody,
  getAuthUser,
  canAccessOwned,
  ownerFor,
  isWorkingDirAllowed,
  sessionCapacityMessage,
} from '../route-helpers.js';
import { rebootRestoreRegistry } from '../reboot-restore-registry.js';
import { rejectAlreadyLive, type RebootRestoreEntry, type RebootRestoreRejection } from '../../reboot-restore.js';
import { clampEnvOverridesForOwner } from '../../session-env-clamp.js';
import { Session } from '../../session.js';
import { resolveClaudeModeForUsername } from '../../user-store.js';
import { getCli } from '../../config/cli-registry/registry.js';
import { applyWorkspaceHooks } from '../../hooks-config.js';
import { getLifecycleLog } from '../../session-lifecycle-log.js';
import { STATS_COLLECTION_INTERVAL_MS } from '../../config/server-timing.js';
import { SseEvent } from '../sse-events.js';
import type { SessionAttachmentHistoryItem } from '../../types.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

type RebootRestoreCtx = SessionPort & EventPort & ConfigPort & InfraPort;

/** The banner's view of one restorable session. The record itself never leaves the server. */
function toBannerItem(entry: RebootRestoreEntry) {
  return {
    id: entry.sessionId,
    name: entry.name,
    workingDir: entry.workingDir,
    mode: entry.mode,
    owner: entry.owner,
  };
}

export function registerRebootRestoreRoutes(app: FastifyInstance, ctx: RebootRestoreCtx): void {
  const accessorFor = (req: Parameters<typeof getAuthUser>[0]) => {
    const user = getAuthUser(req);
    return (owner: string | undefined) => canAccessOwned(user, owner);
  };

  // ========== What is on offer ==========

  app.get('/api/reboot-restore', async (req) => {
    const entries = rebootRestoreRegistry.list(accessorFor(req));
    return {
      sessions: entries.map(toBannerItem),
      // Said plainly here so the banner never implies a full restore: the pane is
      // new, so the conversation continues and the terminal history does not.
      scrollbackRestored: false,
    };
  });

  // ========== Spend it ==========

  app.post('/api/reboot-restore/restore', async (req, reply) => {
    const body = parseBody(RebootRestoreRequestSchema, req.body, 'Invalid reboot restore request');
    const user = getAuthUser(req);
    const canAccess = accessorFor(req);
    const owner = ownerFor(req);

    // Take BEFORE the first await: a second click must find nothing to spend.
    // The flight is per owner, because `take()` already guarantees two callers
    // never receive the same entry, so one user's restore need not block another's.
    if (!rebootRestoreRegistry.beginSpending(owner)) {
      return reply.code(409).send(createErrorResponse(ApiErrorCode.CONFLICT, 'A reboot restore is already running'));
    }
    const taken = rebootRestoreRegistry.take(canAccess, body.sessionIds);
    // Entries nothing built a pane for, returned to the plan on every exit path
    // including a throw. Without this a failure between here and the loop would
    // spend the offer and rebuild nothing, and the plan cannot be rebuilt.
    const unspent = new Set(taken);

    try {
      if (taken.length === 0) return { restored: [], skipped: [] };

      // The plan was built at boot and the board has moved on since. A conversation
      // the user resumed by hand from the Resume list is already on screen, and a
      // second pane on it would fight the first for the same transcript. This one
      // is never re-offered: unlike a missing workspace, it cannot stop being true.
      const liveSessionIds = new Set(ctx.sessions.keys());
      const liveConversationIds = new Set(
        [...ctx.sessions.values()].map((session) => session.claudeSessionId).filter((id): id is string => !!id)
      );
      const { restore, skipped } = rejectAlreadyLive(taken, liveSessionIds, liveConversationIds);
      for (const entry of taken) {
        if (skipped.some((s) => s.sessionId === entry.sessionId)) unspent.delete(entry);
      }

      const restored: ReturnType<typeof toBannerItem>[] = [];
      const failures: RebootRestoreRejection[] = [...skipped];
      const workspaceHooksEnabled = await ctx.getWorkspaceHooksEnabled();

      for (const entry of restore) {
        // Capacity is re-checked per iteration, because this loop is itself
        // creating the sessions it counts. The offer can be a day old, so the
        // board may be fuller now than the plan assumed.
        const capMsg = sessionCapacityMessage(ctx.sessions, entry.owner);
        if (capMsg) {
          failures.push({ sessionId: entry.sessionId, reason: 'capacity-reached' });
          continue;
        }
        // A repo can be deleted between the boot that planned this and the click.
        if (!existsSync(entry.workingDir)) {
          failures.push({ sessionId: entry.sessionId, reason: 'workspace-missing' });
          continue;
        }
        // Multi-user workspace separation: the create route confines a non-admin's
        // workingDir to their own case space, and a grant can be withdrawn between
        // the session's creation and this restore, so the confinement is re-run
        // rather than inherited from the record.
        if (!isWorkingDirAllowed(user, entry.workingDir)) {
          failures.push({ sessionId: entry.sessionId, reason: 'workspace-forbidden' });
          unspent.delete(entry);
          continue;
        }
        try {
          const saved = entry.state;
          const claudeModeConfig = await ctx.getClaudeModeConfig();
          const session = new Session({
            // The old id is reused on purpose: a pinned record, subagent parents,
            // window states and the lifecycle log all key off it, and the unpinned
            // record is gone, so there is nothing to collide with.
            id: saved.id,
            workingDir: saved.workingDir,
            mode: saved.mode,
            name: saved.name,
            createdAt: saved.createdAt,
            mux: ctx.mux,
            useMux: true,
            // No `muxSession`: the reboot took the pane with it, so `startInteractive()`
            // takes its create branch and makes a fresh one.
            claudeMode: await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, saved.owner),
            allowedTools: claudeModeConfig.allowedTools,
            resumeSessionId: entry.resumeConversationId,
            // Re-resolved against the owner's CURRENT grant, never replayed from the
            // record: a grant held when the record was written may be gone now.
            envOverrides: await clampEnvOverridesForOwner(
              saved.owner,
              (saved as { __envOverrides?: Record<string, string> }).__envOverrides
            ),
            effort: saved.effort,
            attachmentHistory:
              (saved as { __attachmentHistory?: SessionAttachmentHistoryItem[] }).__attachmentHistory ??
              saved.attachmentHistory,
            lastSubmitAt: saved.lastSubmitAt,
            claudeSessionChain: saved.claudeSessionChain,
            lastActivityAt: saved.lastActivityAt,
            owner: saved.owner,
            parentSessionId: saved.parentSessionId,
          });

          await ctx.addSession(session);
          await ctx.setupSessionListeners(session);
          // Before the pane spawns: the custom-model selection reaches it through
          // the environment. Before the first persist: a constructed session holds
          // none of this, so persisting it first would replace the fuller record
          // with the reduced one and drop the pin that keeps it from being pruned.
          await ctx.reapplyPersistedSessionState(session, saved);
          await session.startInteractive();
          ctx.persistSessionState(session);

          // A session without its workspace hooks goes silently blind: no stop or
          // idle events for respawn, no Approvals Inbox item, no red tab on a
          // blocking dialog. The boot-time sweep finished hours ago, so the click
          // path installs them itself. `hooks: 'always'` is the capability that says
          // this CLI installs Codeman's hooks into the workspace.
          if (workspaceHooksEnabled && getCli(session.mode)?.capabilities.hooks === 'always') {
            await applyWorkspaceHooks(session.workingDir, true).catch((err: unknown) =>
              console.warn(`[reboot-restore] hook install failed for ${session.workingDir}: ${getErrorMessage(err)}`)
            );
          }

          getLifecycleLog().log({ event: 'recovered', sessionId: session.id, name: session.name });
          // Every other open tab and phone needs this; the clicking tab already has
          // the response, and the client's handler is an idempotent upsert.
          ctx.broadcast(SseEvent.SessionCreated, ctx.getSessionStateWithRespawn(session));
          restored.push(toBannerItem(entry));
        } catch (err) {
          // One entry that will not start must not stop the rest of the pass, and
          // must not leave a registered session with no pane behind it: by this
          // point the session is in `ctx.sessions`, holds a tab-layout slot and has
          // listeners, and the commonest cause is a CLI binary that is not on the
          // PATH of a freshly booted machine.
          console.error(`[reboot-restore] failed to rebuild ${entry.sessionId}:`, err);
          await ctx
            .cleanupSession(entry.sessionId, true, 'reboot restore failed to start the session')
            .catch((cleanupErr: unknown) =>
              console.error(`[reboot-restore] cleanup after a failed rebuild failed: ${getErrorMessage(cleanupErr)}`)
            );
          failures.push({ sessionId: entry.sessionId, reason: 'rebuild-failed' });
          // Left on offer: the user can put the binary back and click again.
          continue;
        }
        unspent.delete(entry);
      }

      if (restored.length > 0) {
        // A reboot leaves recovery with nothing alive to find, so its own block never
        // started the stats collector. This clears and re-arms its interval, so it is
        // safe to call whether or not the collector is already running.
        ctx.mux.startStatsCollection(STATS_COLLECTION_INTERVAL_MS);
      }

      return { restored, skipped: failures };
    } finally {
      // Anything that never became a pane goes back on offer, including after a
      // throw, so a transient failure costs a retry rather than the whole plan.
      rebootRestoreRegistry.restore([...unspent]);
      rebootRestoreRegistry.endSpending(owner);
    }
  });

  // ========== Drop it ==========

  app.post('/api/reboot-restore/dismiss', async (req) => {
    const dismissed = rebootRestoreRegistry.clear(accessorFor(req));
    return { dismissed };
  });
}
