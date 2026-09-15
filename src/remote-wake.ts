/**
 * @fileoverview Wake a SLEEPING remote host from user input (user-triggered Wake-on-LAN).
 *
 * A durable remote session survives SSH drops (COD-104) and auto-reconnects
 * (COD-108), but nothing brings the HOST back: if the remote machine suspended,
 * the local tmux pane's `ssh` child stalls silently. `tmux send-keys` then
 * SUCCEEDS against a pane that will never deliver the bytes, so typed input is
 * lost with no error anywhere — the failure this module exists to close.
 *
 * Design (deliberately narrow, see docs/remote-sessions.md §Wake-on-LAN):
 *  - ONLY real user input wakes a host. The auto-reconnect watcher and
 *    boot-recovery must never wake one, or a host would be re-woken ~45 s after
 *    each suspend and could never stay asleep (the "keepalive pings a sleeping
 *    host" failure already solved for a different consumer by
 *    `hufflepuff-mcp-lazy`).
 *  - Detection is a cheap TCP connect to the SSH port (no auth, no ssh client,
 *    a few hundred bytes — below any meaningful activity threshold), throttled
 *    per session. No SSH keepalive is added to the launch command: keepalives
 *    would move bytes into an otherwise idle connection every interval, which is
 *    exactly the "an open pipe keeps the host awake" bug the remote-side idle
 *    detector was rewritten to avoid.
 *  - While a wake is in flight, input is BUFFERED and flushed in order once the
 *    pane is reattached, so the user's first characters after a long pause are
 *    not the ones that get eaten.
 *
 * The pure decisions and the IO are separated so the decision table can be
 * unit-tested without tmux, ssh, or a real host.
 *
 * @module remote-wake
 */

import { spawn } from 'node:child_process';
import net from 'node:net';

/** Minimum spacing between two reachability probes for the same session. */
export const REMOTE_WAKE_PROBE_MIN_INTERVAL_MS = 30_000;
/** TCP-connect timeout for a reachability probe (host awake ≈ a few ms). */
export const REMOTE_WAKE_PROBE_TIMEOUT_MS = 1_500;
/** Poll spacing while waiting for a woken host to accept SSH again. */
export const REMOTE_WAKE_READY_INTERVAL_MS = 1_500;
/** Bounded wait for the host to come back after the wake command ran. */
export const REMOTE_WAKE_READY_TIMEOUT_MS = 90_000;
/** The wake command itself must not hang the wake flow. */
export const REMOTE_WAKE_COMMAND_TIMEOUT_MS = 10_000;
/**
 * Settle time between respawning the ssh pane and flushing buffered input: the
 * respawned `ssh` needs a moment to run `tmux -L codeman-remote … -A` and attach,
 * and bytes written into a still-connecting pane land in nothing.
 */
export const REMOTE_WAKE_ATTACH_SETTLE_MS = 1_500;
/**
 * Cap on buffered input per session while a host is being woken. 4 KB is a lot
 * of typing for a ~10 s wake; beyond it the OLDEST bytes are dropped (keeping the
 * tail preserves what the user just typed, and a silently unbounded buffer would
 * be a memory leak keyed on user input).
 */
export const REMOTE_WAKE_PENDING_MAX_BYTES = 4096;
/** Default SSH port used when the host config has no explicit `port`. */
export const DEFAULT_SSH_PORT = 22;

/** What the input path should do with a chunk of user input. Pure. */
export type RemoteInputAction = 'deliver' | 'probe' | 'buffer';

/**
 * The caller-facing outcome of {@link RemoteWakeRegistry.handleInput}: either the
 * caller writes the bytes as usual, or the registry took ownership of them.
 */
export type RemoteInputOutcome = 'deliver' | 'buffered';

/**
 * Decide what to do with an input chunk on an input route. Mirrors
 * {@link RemoteWakeRegistry.handleInput} so the throttle table has exactly ONE
 * definition and is unit-testable:
 *
 *  - a wake already in flight → buffer (the flush owns delivery),
 *  - no wake command configured → deliver (feature off, today's behavior),
 *  - the last probe said "down" → buffer (no second probe; re-probing a known
 *    sleeping host on every keystroke would add seconds of latency per character),
 *  - never probed / throttle window elapsed → probe,
 *  - probed "up" inside the window → deliver.
 *
 * Pure — no clock, no IO.
 */
export function decideRemoteInputAction(args: {
  hasWakeCommand: boolean;
  waking: boolean;
  probeAgeMs: number;
  lastReachable?: boolean;
  minProbeIntervalMs?: number;
}): RemoteInputAction {
  if (args.waking) return 'buffer';
  if (!args.hasWakeCommand) return 'deliver';
  if (args.lastReachable === false) return 'buffer';
  const interval = args.minProbeIntervalMs ?? REMOTE_WAKE_PROBE_MIN_INTERVAL_MS;
  if (args.probeAgeMs >= interval) return 'probe';
  return 'deliver';
}

/**
 * Append `data` to the pending buffer, dropping the OLDEST bytes when the cap is
 * exceeded. Returns the resulting buffer. Pure.
 */
export function appendBoundedPending(
  pending: string[],
  data: string,
  maxBytes = REMOTE_WAKE_PENDING_MAX_BYTES
): string[] {
  const next = [...pending, data];
  let total = next.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  while (next.length > 1 && total > maxBytes) {
    total -= Buffer.byteLength(next[0]);
    next.shift();
  }
  return next;
}

/** The remote fields the wake flow needs. Structurally satisfied by `SessionRemote`. */
export interface WakeableRemote {
  wakeCommand?: string;
  hostId: string;
  label: string;
  host: string;
  port?: number;
}

/**
 * The slice of `Session` the wake flow uses — an interface rather than the
 * concrete class so the registry is testable without a tmux server.
 */
export interface WakeableSession {
  readonly id: string;
  readonly remote: WakeableRemote | undefined;
  /** COD-108 reattach: respawns the local ssh pane, idempotently attaching the durable remote tmux. */
  reattachRemote(): Promise<boolean>;
  /** Write bytes to the session's pane. */
  writeViaMux(data: string): Promise<boolean>;
}

/** Injected IO so the registry holds no direct dependency on ssh/net/child_process in tests. */
export interface RemoteWakeDeps {
  /** Cheap reachability probe. Must resolve false (never throw) for a sleeping host. */
  probe(remote: WakeableRemote): Promise<boolean>;
  /** Run the host's wake command. Resolves false when it fails to run. */
  wake(command: string): Promise<boolean>;
  /** Poll until the woken host accepts connections again. */
  waitUntilReady(remote: WakeableRemote): Promise<boolean>;
  /** Sleep helper (injected for tests). */
  delay(ms: number): Promise<void>;
  /** Notify the COD-108 watcher so an exhausted backoff is reset. */
  noteReconnected?(sessionId: string, success: boolean): void;
  /** SSE broadcast. */
  broadcast?(
    event: 'remote:hostWaking' | 'remote:hostWakeFailed' | 'remote:sessionReconnected',
    payload: Record<string, unknown>
  ): void;
  /** Structured diagnostics. */
  log?(message: string): void;
}

/** Per-session wake bookkeeping. */
interface WakeState {
  probedAt: number;
  reachable?: boolean;
  waking: Promise<boolean> | null;
  pending: string[];
}

/**
 * Per-session wake state + single-flight wake flow.
 *
 * One instance per web server (module singleton in the routes file, like the
 * signal-wait registry). State is keyed by session id and dropped with the
 * session.
 */
export class RemoteWakeRegistry {
  private readonly states = new Map<string, WakeState>();

  constructor(private readonly deps: RemoteWakeDeps) {}

  /** Drop a session's state (session closed/killed). The pending buffer goes with it. */
  drop(sessionId: string): void {
    this.states.delete(sessionId);
  }

  /** Whether a wake is currently in flight (diagnostics/tests). */
  isWaking(sessionId: string): boolean {
    return this.states.get(sessionId)?.waking != null;
  }

  /** Buffered input bytes for a session (diagnostics/tests). */
  pendingBytes(sessionId: string): number {
    const state = this.states.get(sessionId);
    if (!state) return 0;
    return state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
  }

  /**
   * Decide + act for one input chunk.
   *
   * `'deliver'` means the caller writes it as usual (today's path, zero added
   * cost). `'buffered'` means the registry took ownership of the bytes: it either
   * queued them behind an in-flight wake or started a wake, and will flush them
   * in order once the pane is reattached.
   */
  async handleInput(session: WakeableSession, data: string): Promise<RemoteInputOutcome> {
    const remote = session.remote;
    const state = this._state(session.id);
    const action = decideRemoteInputAction({
      hasWakeCommand: Boolean(remote?.wakeCommand),
      waking: state.waking != null,
      probeAgeMs: Date.now() - state.probedAt,
      lastReachable: state.reachable,
    });

    if (action === 'deliver') return 'deliver';
    if (action === 'buffer') {
      this._enqueue(session.id, data);
      // A buffered verdict with no wake in flight still has to DRIVE a wake (the
      // previous one failed and reset the probe state, or the ladder landed here
      // directly) — otherwise the bytes would sit in the buffer forever.
      if (state.waking == null && remote?.wakeCommand) void this.wake(session);
      return 'buffered';
    }

    // action === 'probe' — the throttle window elapsed, so one TCP connect is owed.
    state.probedAt = Date.now();
    state.reachable = remote ? await this.deps.probe(remote) : true;
    if (state.reachable) return 'deliver';

    this._enqueue(session.id, data);
    void this.wake(session);
    return 'buffered';
  }

  /**
   * Block until the host is reachable and the pane is reattached — the
   * send-and-wait path, where the HTTP response stays open anyway and buffering
   * would break the wait contract.
   */
  async ensureAwake(session: WakeableSession): Promise<boolean> {
    const remote = session.remote;
    if (!remote?.wakeCommand) return true;
    const state = this._state(session.id);
    if (state.reachable !== false && Date.now() - state.probedAt >= REMOTE_WAKE_PROBE_MIN_INTERVAL_MS) {
      state.probedAt = Date.now();
      state.reachable = await this.deps.probe(remote);
    }
    if (state.reachable) return true;
    return this.wake(session);
  }

  /**
   * Single-flight wake: probe-free (the caller already knows the host is down),
   * run the wake command, poll for readiness, reattach the pane, flush the buffer.
   */
  async wake(session: WakeableSession): Promise<boolean> {
    const remote = session.remote;
    if (!remote?.wakeCommand) return true;
    const state = this._state(session.id);
    if (state.waking) return state.waking;

    state.waking = (async (): Promise<boolean> => {
      const id = session.id;
      try {
        this.deps.broadcast?.('remote:hostWaking', { sessionId: id, hostId: remote.hostId, label: remote.label });
        this.deps.log?.(`[RemoteWake] waking ${remote.label} (${remote.host}) for session ${id}`);

        const woke = await this.deps.wake(remote.wakeCommand as string);
        if (!woke) this.deps.log?.(`[RemoteWake] wake command failed for ${remote.label}: ${remote.wakeCommand}`);

        const ready = await this.deps.waitUntilReady(remote);
        if (!ready) {
          this.deps.log?.(`[RemoteWake] ${remote.label} did not come back — input stays buffered`);
          this.deps.broadcast?.('remote:hostWakeFailed', { sessionId: id, hostId: remote.hostId, label: remote.label });
          // Reset the probe state so the NEXT user input probes and retries
          // instead of trusting a stale "down" verdict forever.
          state.probedAt = 0;
          state.reachable = undefined;
          return false;
        }

        state.reachable = true;
        state.probedAt = Date.now();
        const reattached = await session.reattachRemote();
        if (!reattached) {
          this.deps.log?.(`[RemoteWake] ${remote.label} is up but the pane could not be reattached`);
          return false;
        }
        // The reset also clears an EXHAUSTED COD-108 backoff, which otherwise
        // never fires again for this session (see remote-reconnect.ts).
        this.deps.noteReconnected?.(id, true);
        this.deps.broadcast?.('remote:sessionReconnected', { sessionId: id });
        this.deps.log?.(`[RemoteWake] ${remote.label} reattached for session ${id}`);

        await this.deps.delay(REMOTE_WAKE_ATTACH_SETTLE_MS);
        await this._flush(state, session);
        return true;
      } catch (err) {
        this.deps.log?.(`[RemoteWake] unexpected failure: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        state.waking = null;
      }
    })();

    return state.waking;
  }

  private _state(sessionId: string): WakeState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { probedAt: 0, reachable: undefined, waking: null, pending: [] };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private _enqueue(sessionId: string, data: string): void {
    const state = this._state(sessionId);
    const before = state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    state.pending = appendBoundedPending(state.pending, data);
    const after = state.pending.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0);
    if (before + Buffer.byteLength(data) > after) {
      this.deps.log?.(`[RemoteWake] pending buffer cap reached for session ${sessionId} — oldest input dropped`);
    }
  }

  private async _flush(state: WakeState, session: WakeableSession): Promise<void> {
    while (state.pending.length > 0) {
      const chunk = state.pending[0];
      const ok = await session.writeViaMux(chunk).catch(() => false);
      if (!ok) {
        this.deps.log?.(
          `[RemoteWake] flush failed for session ${session.id} — ${state.pending.length} chunk(s) retained`
        );
        return;
      }
      state.pending.shift();
    }
  }
}

// ========== Default IO ==========

/**
 * Cheap reachability probe: a bare TCP connect to the SSH port.
 *
 * Deliberately NOT an `ssh … true` probe: that opens a full session (auth,
 * remote log, process) every throttle window for a question a SYN already
 * answers. Any byte count it does move is a few hundred bytes per probe, far
 * below the remote idle detector's traffic threshold, so probing cannot keep a
 * host awake.
 */
export function probeRemoteHostReachable(
  remote: WakeableRemote,
  timeoutMs = REMOTE_WAKE_PROBE_TIMEOUT_MS
): Promise<boolean> {
  const port = remote.port ?? DEFAULT_SSH_PORT;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: remote.host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Run a host's wake command (e.g. a Wake-on-LAN wrapper script). No shell — the
 * value is a single executable path, so nothing in it can be interpreted.
 * Resolves false on any failure (missing binary, non-zero exit, timeout) rather
 * than throwing: a broken wake command must not break the input route.
 */
export function runRemoteWakeCommand(command: string, timeoutMs = REMOTE_WAKE_COMMAND_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [], { stdio: 'ignore' });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false);
    }, timeoutMs);
    child.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/** Poll the host until it accepts connections again, or the bound is hit. */
export async function waitUntilRemoteReady(
  remote: WakeableRemote,
  opts: { intervalMs?: number; timeoutMs?: number; probe?: (remote: WakeableRemote) => Promise<boolean> } = {}
): Promise<boolean> {
  const intervalMs = opts.intervalMs ?? REMOTE_WAKE_READY_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? REMOTE_WAKE_READY_TIMEOUT_MS;
  const probe = opts.probe ?? probeRemoteHostReachable;
  const deadline = Date.now() + timeoutMs;
  // Probe immediately: WoL from a warm S3 is fast (~7.5 s measured on this setup),
  // and the first poll is what turns "just woke" into a sub-interval response.
  for (;;) {
    if (await probe(remote)) return true;
    if (Date.now() + intervalMs > deadline) return false;
    await delay(intervalMs);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Production wiring: all IO defaults, overridable for tests. */
export function createDefaultRemoteWakeDeps(overrides: Partial<RemoteWakeDeps> = {}): RemoteWakeDeps {
  return {
    probe: probeRemoteHostReachable,
    wake: runRemoteWakeCommand,
    waitUntilReady: (remote) => waitUntilRemoteReady(remote),
    delay,
    ...overrides,
  };
}
