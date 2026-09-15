import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultRemoteCommandForMode,
  readRemoteCases,
  readRemoteHosts,
  remoteDisplayPath,
  remoteSshTarget,
  toSessionRemote,
  writeRemoteCases,
  writeRemoteHosts,
} from '../src/remote-hosts.js';
import { RemoteHostSchema } from '../src/web/schemas.js';

describe('remote-hosts domain', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function configDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'codeman-remote-hosts-'));
    return dir;
  }

  it('round-trips remote hosts and remote cases from a config directory', async () => {
    const root = configDir();
    await writeRemoteHosts(root, [
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await writeRemoteCases(root, [
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);

    await expect(readRemoteHosts(root)).resolves.toEqual([
      {
        id: 'gpu-box',
        label: 'GPU Box',
        host: '10.0.0.42',
        username: 'ubuntu',
        commands: { codex: 'exec codx personal' },
      },
    ]);
    await expect(readRemoteCases(root)).resolves.toEqual([
      { name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
    ]);
  });

  it('returns safe mode defaults and remote display values', () => {
    expect(defaultRemoteCommandForMode('shell')).toBe('exec "${SHELL:-/bin/sh}" -i -l');
    // Routed through an interactive login shell so per-user PATH entries (e.g.
    // ~/.local/bin, ~/.opencode/bin) resolve — a bare `exec codex` sees only
    // sshd's minimal default PATH and fails with "command not found".
    expect(defaultRemoteCommandForMode('codex')).toBe('exec "${SHELL:-/bin/sh}" -i -l -c \'codex\'');
    // Mirrors the local claude default so the remote agent runs non-interactively.
    expect(defaultRemoteCommandForMode('claude')).toBe(
      'exec "${SHELL:-/bin/sh}" -i -l -c \'claude --dangerously-skip-permissions\''
    );
    expect(remoteSshTarget({ id: 'h1', label: 'H1', host: 'box.local', username: 'aamer' })).toBe('aamer@box.local');
    expect(remoteDisplayPath({ username: 'aamer', host: 'box.local', path: '/opt/work' })).toBe(
      'aamer@box.local:/opt/work'
    );
  });

  it('carries the wake command from host config into the session', () => {
    // The input route reads `session.remote.wakeCommand` — it must survive the host
    // -> session mapping, or wake-on-LAN silently degrades to "no wake command".
    const remote = toSessionRemote(
      {
        id: 'hufflepuff',
        label: 'Hufflepuff',
        host: '192.168.50.137',
        username: 'j',
        wakeCommand: '/home/joe/bin/whuff',
      },
      { name: 'c', type: 'remote', hostId: 'hufflepuff', remotePath: '/home/j/work' }
    );
    expect(remote.wakeCommand).toBe('/home/joe/bin/whuff');
  });

  it('omits the wake command by default (feature off without a config entry)', () => {
    const remote = toSessionRemote(
      { id: 'h', label: 'H', host: '10.0.0.1', username: 'j' },
      { name: 'c', type: 'remote', hostId: 'h', remotePath: '/tmp' }
    );
    expect(remote.wakeCommand).toBeUndefined();
  });

  describe('RemoteHostSchema wakeCommand', () => {
    const host = { id: 'hufflepuff', label: 'Hufflepuff', host: '192.168.50.137', username: 'j' };

    it('accepts an optional absolute executable path', () => {
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/home/joe/bin/whuff' }).success).toBe(true);
      expect(RemoteHostSchema.safeParse(host).success).toBe(true);
    });

    it('rejects an argument list (spawn runs the path without a shell)', () => {
      // `spawn('/home/joe/bin/whuff --mac 00:11:22')` would fail as a confusing
      // ENOENT at wake time — refuse it at config time instead.
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/home/joe/bin/whuff --now' }).success).toBe(false);
    });

    it('rejects shell metacharacters as defence in depth', () => {
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/bin/sh$(id)' }).success).toBe(false);
      expect(RemoteHostSchema.safeParse({ ...host, wakeCommand: '/bin/`id`' }).success).toBe(false);
    });
  });
});
