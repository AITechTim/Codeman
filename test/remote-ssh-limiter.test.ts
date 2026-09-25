/**
 * @fileoverview Tests for the remote-file ssh concurrency limiter
 * (`src/remote-ssh-limiter.ts`): the cap holds under interleaved async resumption,
 * waiters are served FIFO, and a task that throws still releases its slot.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect } from 'vitest';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  runWithRemoteSshLimit,
} from '../src/remote-ssh-limiter.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('runWithRemoteSshLimit', () => {
  it('never lets more than the cap run at once, and queues the rest FIFO', async () => {
    const cap = getRemoteSshLimit();
    const gates = Array.from({ length: cap + 3 }, () => deferred());
    const started: number[] = [];
    let peak = 0;

    const runs = gates.map((gate, index) =>
      runWithRemoteSshLimit(async () => {
        started.push(index);
        peak = Math.max(peak, getActiveRemoteSshCount());
        await gate.promise;
        return index;
      })
    );
    await Promise.resolve();

    expect(started).toEqual(Array.from({ length: cap }, (_, i) => i));
    expect(getActiveRemoteSshCount()).toBe(cap);
    expect(getQueuedRemoteSshCount()).toBe(3);

    // Releasing one hands the slot to the OLDEST waiter; the count stays at the cap.
    gates[0].resolve();
    await runs[0];
    await Promise.resolve();
    expect(started).toEqual([...Array.from({ length: cap }, (_, i) => i), cap]);
    expect(getActiveRemoteSshCount()).toBe(cap);

    for (const gate of gates) gate.resolve();
    expect(await Promise.all(runs)).toEqual(gates.map((_, i) => i));
    expect(peak).toBe(cap);
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(getQueuedRemoteSshCount()).toBe(0);
  });

  it('releases the slot when the task throws', async () => {
    await expect(runWithRemoteSshLimit(async () => Promise.reject(new Error('ssh exit 255')))).rejects.toThrow(
      'ssh exit 255'
    );
    expect(getActiveRemoteSshCount()).toBe(0);
    expect(await runWithRemoteSshLimit(async () => 'after')).toBe('after');
  });
});
