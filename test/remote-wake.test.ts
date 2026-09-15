/**
 * @fileoverview Wake-on-LAN from user input (see `src/remote-wake.ts`).
 *
 * Covers the two things that are easy to get wrong and expensive when wrong:
 *  1. the decision/throttle table (probe at most once per window, never a probe
 *     burst per keystroke),
 *  2. the guarantee that a wake is SINGLE-FLIGHT and that buffered input is
 *     flushed IN ORDER once the pane is reattached — plus that no reconnect or
 *     boot-recovery module can reach the wake flow at all (a wake there would
 *     re-wake the host seconds after every suspend, so it could never sleep).
 *
 * Pure logic + a fake session/deps: no tmux, no ssh, no real host.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
  RemoteWakeRegistry,
  appendBoundedPending,
  decideRemoteInputAction,
  REMOTE_WAKE_PENDING_MAX_BYTES,
  type RemoteWakeDeps,
  type WakeableRemote,
  type WakeableSession,
} from '../src/remote-wake.js';

// ========== Pure decisions ==========

describe('decideRemoteInputAction', () => {
  const base = { hasWakeCommand: true, waking: false, probeAgeMs: 0, lastReachable: undefined as boolean | undefined };

  it('delivers unchanged when the host has no wake command (feature off)', () => {
    expect(decideRemoteInputAction({ ...base, hasWakeCommand: false, probeAgeMs: Number.MAX_SAFE_INTEGER })).toBe(
      'deliver'
    );
  });

  it('buffers while a wake is already in flight, whatever the probe state says', () => {
    expect(decideRemoteInputAction({ ...base, waking: true, probeAgeMs: Number.MAX_SAFE_INTEGER })).toBe('buffer');
  });

  it('buffers without re-probing when the last probe said the host is down', () => {
    // Re-probing per keystroke would add seconds of latency to every character.
    expect(decideRemoteInputAction({ ...base, lastReachable: false, probeAgeMs: 1 })).toBe('buffer');
  });

  it('delivers inside the throttle window when the host was reachable', () => {
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 10 })).toBe('deliver');
  });

  it('probes once the throttle window has elapsed', () => {
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 30_001 })).toBe('probe');
    expect(decideRemoteInputAction({ ...base, lastReachable: true, probeAgeMs: 29_999 })).toBe('deliver');
  });

  it('probes on the very first input of a session (probeAgeMs 0 is only "never probed")', () => {
    // probedAt is initialised to 0, so a fresh session's age is huge in real time.
    expect(decideRemoteInputAction({ ...base, probeAgeMs: Date.now() })).toBe('probe');
  });
});

describe('appendBoundedPending', () => {
  it('keeps everything under the cap, in order', () => {
    expect(appendBoundedPending(['a', 'b'], 'c')).toEqual(['a', 'b', 'c']);
  });

  it('drops the OLDEST chunk when the cap is exceeded, keeping the tail', () => {
    const big = 'x'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES);
    expect(appendBoundedPending([big], 'newest')).toEqual(['newest']);
  });

  it('never drops the just-typed chunk even when it alone exceeds the cap', () => {
    const huge = 'y'.repeat(REMOTE_WAKE_PENDING_MAX_BYTES + 100);
    expect(appendBoundedPending([], huge)).toEqual([huge]);
  });
});

// ========== Registry ==========

const remote: WakeableRemote = {
  hostId: 'hufflepuff',
  label: 'Hufflepuff',
  host: '192.168.50.137',
  wakeCommand: '/home/joe/bin/whuff',
};

interface Harness {
  registry: RemoteWakeRegistry;
  session: WakeableSession;
  probe: ReturnType<typeof vi.fn>;
  wake: ReturnType<typeof vi.fn>;
  waitUntilReady: ReturnType<typeof vi.fn>;
  reattachRemote: ReturnType<typeof vi.fn>;
  writeViaMux: ReturnType<typeof vi.fn>;
  noteReconnected: ReturnType<typeof vi.fn>;
  events: string[];
}

function harness(opts: { remote?: WakeableRemote; writesFail?: boolean } = {}): Harness {
  const probe = vi.fn(async () => false);
  const wake = vi.fn(async () => true);
  const waitUntilReady = vi.fn(async () => true);
  const reattachRemote = vi.fn(async () => true);
  const writeViaMux = vi.fn(async () => !opts.writesFail);
  const noteReconnected = vi.fn();
  const events: string[] = [];

  const deps: RemoteWakeDeps = {
    probe,
    wake,
    waitUntilReady,
    delay: async () => {},
    noteReconnected,
    broadcast: (event) => events.push(event),
    log: () => {},
  };

  const session: WakeableSession = {
    id: 'sess-1',
    remote: opts.remote ?? remote,
    reattachRemote,
    writeViaMux,
  };

  return {
    registry: new RemoteWakeRegistry(deps),
    session,
    probe,
    wake,
    waitUntilReady,
    reattachRemote,
    writeViaMux,
    noteReconnected,
    events,
  };
}

describe('RemoteWakeRegistry', () => {
  it('does nothing at all when the host has no wake command', async () => {
    const h = harness({ remote: { hostId: 'x', label: 'X', host: '10.0.0.9' } });
    await expect(h.registry.handleInput(h.session, 'a')).resolves.toBe('deliver');
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('delivers normally when the host is reachable, without waking', async () => {
    const h = harness();
    h.probe.mockResolvedValue(true);
    await expect(h.registry.handleInput(h.session, 'a')).resolves.toBe('deliver');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('skips the probe inside the throttle window once the host was reachable', async () => {
    const h = harness();
    h.probe.mockResolvedValue(true);
    await h.registry.handleInput(h.session, 'a');
    await h.registry.handleInput(h.session, 'b');
    await h.registry.handleInput(h.session, 'c');
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('wakes an unreachable host once, then flushes buffered input in order after reattach', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    // Hold the wake open so the second input lands while it is genuinely in flight
    // (with instantaneous mocks the whole wake chain can finish between two awaits).
    let releaseWake: (() => void) | undefined;
    h.waitUntilReady.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseWake = () => resolve(true);
        })
    );

    await expect(h.registry.handleInput(h.session, 'hal')).resolves.toBe('buffered');
    await expect(h.registry.handleInput(h.session, 'lo')).resolves.toBe('buffered');
    // Single-flight: the second input joins the in-flight wake, it does not start another.
    expect(h.registry.isWaking('sess-1')).toBe(true);
    expect(h.wake).toHaveBeenCalledTimes(1);

    releaseWake?.();
    await h.registry.wake(h.session);

    expect(h.wake).toHaveBeenCalledWith('/home/joe/bin/whuff');
    expect(h.reattachRemote).toHaveBeenCalledTimes(1);
    expect(h.noteReconnected).toHaveBeenCalledWith('sess-1', true);
    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual(['hal', 'lo']);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    expect(h.events).toEqual(['remote:hostWaking', 'remote:sessionReconnected']);
  });

  it('keeps input buffered and reports failure when the host never comes back', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'hello');
    await h.registry.wake(h.session);

    expect(h.reattachRemote).not.toHaveBeenCalled();
    expect(h.writeViaMux).not.toHaveBeenCalled();
    expect(h.registry.pendingBytes('sess-1')).toBe(5);
    expect(h.events).toContain('remote:hostWakeFailed');
  });

  it('retries the wake on the next input after a failed wake (probe state reset)', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.waitUntilReady.mockResolvedValueOnce(false);

    await h.registry.handleInput(h.session, 'a');
    await h.registry.wake(h.session);
    expect(h.wake).toHaveBeenCalledTimes(1);

    // Next keystroke must probe again (not trust the stale "down" verdict) and retry.
    await h.registry.handleInput(h.session, 'b');
    await h.registry.wake(h.session);
    expect(h.probe).toHaveBeenCalledTimes(2);
    expect(h.wake).toHaveBeenCalledTimes(2);
    expect(h.writeViaMux.mock.calls.map((c) => c[0])).toEqual(['a', 'b']);
  });

  it('does not claim reconnected when the pane cannot be reattached', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    h.reattachRemote.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'a');
    await h.registry.wake(h.session);

    expect(h.noteReconnected).not.toHaveBeenCalled();
    expect(h.writeViaMux).not.toHaveBeenCalled();
    expect(h.events).not.toContain('remote:sessionReconnected');
  });

  it('retains input that could not be written and reports nothing lost', async () => {
    const h = harness({ writesFail: true });
    h.probe.mockResolvedValue(false);

    await h.registry.handleInput(h.session, 'abc');
    await h.registry.wake(h.session);

    expect(h.writeViaMux).toHaveBeenCalledTimes(1);
    expect(h.registry.pendingBytes('sess-1')).toBe(3);
  });

  it('ensureAwake blocks only for the wait path and returns true without a wake command', async () => {
    const h = harness({ remote: { hostId: 'x', label: 'X', host: '10.0.0.9' } });
    await expect(h.registry.ensureAwake(h.session)).resolves.toBe(true);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.wake).not.toHaveBeenCalled();
  });

  it('ensureAwake wakes an unreachable host without buffering anything', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    await expect(h.registry.ensureAwake(h.session)).resolves.toBe(true);
    expect(h.wake).toHaveBeenCalledTimes(1);
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
  });

  it('drops buffered input with the session', async () => {
    const h = harness();
    h.probe.mockResolvedValue(false);
    await h.registry.handleInput(h.session, 'abc');
    h.registry.drop('sess-1');
    expect(h.registry.pendingBytes('sess-1')).toBe(0);
    expect(h.registry.isWaking('sess-1')).toBe(false);
  });
});

// ========== Wiring guard ==========

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
      continue;
    }
    if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('wake wiring guard', () => {
  it('only the input route may reach the wake registry', () => {
    // The auto-reconnect watcher (tmux-manager.ts), the server's dropped-session
    // handler and any boot-recovery path must NOT import remote-wake: waking there
    // re-wakes the host seconds after each suspend. Asserted, not commented.
    const allowed = new Set([join('web', 'routes', 'session-routes.ts')]);
    const importers = walkTs(SRC)
      .filter((full) => /from\s+['"][^'"]*remote-wake(\.js)?['"]/.test(readFileSync(full, 'utf-8')))
      .map((full) => relative(SRC, full));

    expect(importers.sort()).toEqual([...allowed].sort());
  });
});
