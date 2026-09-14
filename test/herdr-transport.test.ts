import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';

const fake = vi.hoisted(() => {
  const processes: Array<{
    pid: number;
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    onData: (cb: (data: string) => void) => { dispose(): void };
    onExit: (cb: (event: { exitCode: number }) => void) => { dispose(): void };
    data: (data: string) => void;
    exit: (code?: number) => void;
  }> = [];
  const spawn = vi.fn(() => {
    const data = new Set<(data: string) => void>();
    const exits = new Set<(event: { exitCode: number }) => void>();
    const process = {
      pid: 90000 + processes.length,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData(cb: (data: string) => void) {
        data.add(cb);
        return {
          dispose: () => {
            data.delete(cb);
          },
        };
      },
      onExit(cb: (event: { exitCode: number }) => void) {
        exits.add(cb);
        return {
          dispose: () => {
            exits.delete(cb);
          },
        };
      },
      data(value: string) {
        for (const cb of data) cb(value);
      },
      exit(exitCode = 0) {
        for (const cb of [...exits]) cb({ exitCode });
      },
    };
    process.kill.mockImplementation(() => queueMicrotask(() => process.exit()));
    processes.push(process);
    return process;
  });
  return { spawn, processes };
});
vi.mock('node-pty', () => ({ spawn: fake.spawn }));
import { Session } from '../src/session.js';

const sessions: Session[] = [];
function fixture(restored = true) {
  const muxSession = {
    sessionId: 'transport-test',
    muxName: 'term_test',
    terminalId: 'term_test',
    mode: 'codex',
    workingDir: '/tmp',
    runtimeStatus: 'idle',
    createdAt: Date.now(),
    pid: 1,
  } as MuxSession;
  const mux = {
    backend: 'herdr',
    muxSessionExists: vi.fn(() => true),
    isPaneDead: vi.fn(() => false),
    createSession: vi.fn(async () => muxSession),
    setAttached: vi.fn(),
    sendInput: vi.fn(async () => true),
    getSession: vi.fn(() => muxSession),
  } as unknown as TerminalMultiplexer;
  const session = new Session({
    id: 'transport-test',
    workingDir: '/tmp',
    mode: 'codex',
    mux,
    useMux: true,
    ...(restored ? { muxSession } : {}),
  });
  sessions.push(session);
  return { session, mux, muxSession };
}
beforeEach(() => {
  fake.processes.length = 0;
  fake.spawn.mockClear();
});
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.stop(false);
  vi.useRealTimers();
});

describe('Herdr attachment lifecycle', () => {
  it('joins creation, HTTP starts, shell starts, and browser retains before spawning once', async () => {
    const { session, mux, muxSession } = fixture(false);
    let complete!: (value: MuxSession) => void;
    vi.mocked(mux.createSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const creating = session.startInteractive();
    await vi.waitFor(() => expect(mux.createSession).toHaveBeenCalledOnce());
    // Reconciliation can expose the terminal while agent startup is still pending.
    session.syncMuxRuntime(muxSession);
    const http = session.startInteractive();
    const shell = session.startShell();
    const browser = session.retainInteractiveTransport({ cols: 180, rows: 50 });
    complete(muxSession);
    await Promise.all([creating, http, shell, browser]);
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(mux.createSession).toHaveBeenCalledOnce();
    expect(session.pid).toBe(fake.processes[0].pid);
    expect(session.terminalTransport).toBe('connected');
  });

  it('ignores stale exit and output after replacement, preserving writes and resizing', async () => {
    const { session } = fixture();
    await session.retainInteractiveTransport();
    const old = fake.processes[0];
    old.exit(1);
    await session.startInteractive();
    const current = fake.processes[1];
    const output = vi.fn();
    session.on('terminal', output);
    old.data('stale terminal output');
    old.exit(1);
    expect(output).not.toHaveBeenCalled();
    expect(session.pid).toBe(current.pid);
    expect(session.write('hello')).toBe(true);
    session.resize(80, 25);
    expect(current.write).toHaveBeenCalledWith('hello');
    expect(current.resize).toHaveBeenCalledWith(80, 25);
  });

  it('shares claims and keeps the attachment through reconnect inside the grace period', async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    await Promise.all([session.retainInteractiveTransport(), session.retainInteractiveTransport()]);
    session.releaseInteractiveTransport();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fake.processes[0].kill).not.toHaveBeenCalled();
    session.releaseInteractiveTransport();
    await vi.advanceTimersByTimeAsync(4000);
    await session.retainInteractiveTransport();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(fake.processes[0].kill).not.toHaveBeenCalled();
    session.releaseInteractiveTransport();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.processes[0].kill).toHaveBeenCalledOnce();
    expect(session.pid).toBeNull();
  });

  it('waits for retirement before reattaching', async () => {
    vi.useFakeTimers();
    const { session } = fixture();
    await session.retainInteractiveTransport();
    const old = fake.processes[0];
    old.kill.mockImplementation(() => {});
    session.releaseInteractiveTransport();
    await vi.advanceTimersByTimeAsync(5000);
    const reconnect = session.retainInteractiveTransport();
    await Promise.resolve();
    expect(fake.spawn).toHaveBeenCalledOnce();
    old.exit();
    await reconnect;
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });

  it('recognizes split takeover diagnostics and only explicit reclaim clears the conflict', async () => {
    const { session, mux } = fixture();
    await session.retainInteractiveTransport();
    fake.processes[0].data('herdr: server shut down: terminal attach taken ');
    fake.processes[0].data('over\r\n');
    fake.processes[0].exit(1);
    expect(session.terminalTransport).toBe('conflict');
    expect(session.write('pending')).toBe(false);
    expect(await session.writeViaMux('pending')).toBe(false);
    expect(mux.sendInput).not.toHaveBeenCalled();
    await expect(session.startInteractive()).rejects.toThrow('controlled elsewhere');
    expect(fake.spawn).toHaveBeenCalledOnce();
    await session.startInteractive({ takeover: true });
    expect(session.terminalTransport).toBe('connected');
    expect(fake.spawn).toHaveBeenCalledTimes(2);
  });

  it('recognizes refusal when an external client already owns the terminal', async () => {
    const { session } = fixture();
    await session.retainInteractiveTransport();
    fake.processes[0].data(
      'herdr: server shut down: terminal attach failed: terminal term_test already has an attached client; retry with --takeover'
    );
    fake.processes[0].exit(1);
    expect(session.toState().terminalTransport).toBe('conflict');
  });

  it('does not spawn an attachment after shutdown interrupts pending creation', async () => {
    const { session, mux, muxSession } = fixture(false);
    let complete!: (value: MuxSession) => void;
    vi.mocked(mux.createSession).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const starting = session.startInteractive();
    const rejected = expect(starting).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(mux.createSession).toHaveBeenCalledOnce());
    const stopping = session.stop(false);
    complete(muxSession);
    await Promise.all([stopping, rejected]);
    expect(fake.spawn).not.toHaveBeenCalled();
  });
});
