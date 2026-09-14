/**
 * @fileoverview Tests for remote (SSH) file access (`src/remote-files.ts`).
 *
 * Two layers are covered:
 *
 * 1. PURE builders/parsers — command construction, escaping and probe parsing, no
 *    connection involved.
 * 2. The probe SCRIPT itself, executed by a real `/bin/sh` against a real temp
 *    directory. The remote shell is the one place where a quoting mistake becomes an
 *    injection, and it cannot be exercised by an ssh-less unit test any other way: the
 *    script IS the remote command, so `sh -c <script>` reproduces exactly what sshd
 *    runs on the other end.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import {
  RemoteFileAccessError,
  buildRemoteFileCommand,
  buildRemoteProbeCommand,
  buildRemoteReadCommand,
  parseRemoteProbeLine,
  parseRemoteProbeLines,
} from '../src/remote-files.js';
import type { SessionRemote } from '../src/types/session.js';

/**
 * Run a shell line through a real `/bin/sh` and return its `$@` as an argv array,
 * WITHOUT executing anything. This is how the tests see the exact argument vector a
 * command line would hand to the process — the local-shell half of the escaping chain.
 */
function shellArgv(command: string): string[] {
  const out = execFileSync('sh', ['-c', `set -- ${command}; printf '%s\\0' "$@"`]);
  // The trailing empty element is the printf format terminator.
  return out.toString().split('\0').slice(0, -1);
}

/** A remote session fixture; every field is optional in production, so keep it minimal. */
function remoteFixture(overrides: Partial<SessionRemote> = {}): SessionRemote {
  return {
    hostId: 'host-1',
    label: 'testhost',
    host: '192.0.2.10',
    username: 'j',
    remotePath: '/srv/case',
    ...overrides,
  };
}

describe('buildRemoteFileCommand', () => {
  it('builds the ssh line from the shared connection args and one shellescaped command', () => {
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), 'cat /etc/hostname'));

    // buildSshConnectionArgs returns tokens, and the shell re-splits them into the
    // flags ssh actually wants (`-o` + `BatchMode=yes`), which is what this pins.
    expect(argv.slice(0, 3)).toEqual(['ssh', '-o', 'BatchMode=yes']);
    expect(argv).toContain('ConnectTimeout=10');
    expect(argv).toContain('j@192.0.2.10');
    // The remote command is ONE argument, whatever it contains.
    expect(argv[argv.length - 1]).toBe('cat /etc/hostname');
    expect(argv[argv.length - 2]).toBe('j@192.0.2.10');
  });

  it('routes port, identity, jump host and extra options through buildSshConnectionArgs', () => {
    const argv = shellArgv(
      buildRemoteFileCommand(
        remoteFixture({
          port: 2222,
          identityFile: '~/.ssh/id_ed25519',
          jumpHost: 'bastion.example.com',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        }),
        'true'
      )
    );

    expect(argv).toContain('-p');
    expect(argv).toContain('2222');
    expect(argv).toContain('-J');
    expect(argv).toContain('bastion.example.com');
    expect(argv).toContain('StrictHostKeyChecking=accept-new');
    // `~` is expanded before escaping: ssh does not expand it inside -i.
    expect(argv).toContain(join(homedir(), '.ssh/id_ed25519'));
  });

  it('keeps a shell-metacharacter command as a single opaque argument', () => {
    const command = "cat '/tmp/it''s here' ; rm -rf ~ #";
    const argv = shellArgv(buildRemoteFileCommand(remoteFixture(), command));

    expect(argv[argv.length - 1]).toBe(command);
    expect(argv).not.toContain('rm');
    expect(argv).not.toContain('-rf');
  });
});

describe('buildRemoteProbeCommand', () => {
  it('probes every path exactly once, each as its own shell-quoted token', () => {
    const script = buildRemoteProbeCommand(['/srv/case/a.png', '/srv/case']);
    const probeCalls = script.split('\n').filter((line) => line.startsWith('probe '));

    expect(probeCalls).toEqual(["probe '/srv/case/a.png'", "probe '/srv/case'"]);
  });

  it('quotes a path with spaces, quotes and a command substitution', () => {
    const nasty = "/srv/case/it's $(touch /tmp/pwned).txt";
    const script = buildRemoteProbeCommand([nasty]);

    expect(script).toContain(`probe '/srv/case/it'\\''s $(touch /tmp/pwned).txt'`);
    expect(shellArgv(buildRemoteFileCommand(remoteFixture(), script)).at(-1)).toBe(script);
  });
});

describe('the probe script on a real shell', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-remote-probe-'));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reports kind, size and realpath for a file, a directory and a missing path', () => {
    const filePath = join(root, 'image.png');
    writeFileSync(filePath, 'fake png bytes');

    const probes = parseRemoteProbeLines(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([filePath, root, join(root, 'nope.png')])]).toString(),
      [filePath, root, join(root, 'nope.png')]
    );

    expect(probes[0]).toMatchObject({ kind: 'file', size: 14, realPath: filePath });
    expect(probes[0]?.mtimeMs).toBeGreaterThan(0);
    expect(probes[1]).toMatchObject({ kind: 'directory', size: 0, realPath: root });
    expect(probes[2]).toBeNull();
  });

  it('resolves a symlink to its target', () => {
    const target = join(root, 'target.txt');
    const link = join(root, 'link.txt');
    writeFileSync(target, 'x');
    execFileSync('ln', ['-s', target, link]);

    const [probe] = parseRemoteProbeLines(execFileSync('sh', ['-c', buildRemoteProbeCommand([link])]).toString(), [
      link,
    ]);

    expect(probe?.realPath).toBe(target);
  });

  it('treats a hostile filename as data, never as a command', () => {
    // No slashes in the payload: it has to be a legal FILENAME on this host while
    // still being a command substitution to a shell.
    const marker = `codeman_pwned_${process.pid}`;
    const hostile = join(root, `it's; touch ${marker}; $(id).txt`);
    writeFileSync(hostile, 'hostile');

    const [probe] = parseRemoteProbeLines(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([hostile])], { cwd: root }).toString(),
      [hostile]
    );

    expect(probe?.realPath).toBe(hostile);
    expect(existsSync(join(root, marker))).toBe(false);
  });

  it('handles a path containing the field separator', () => {
    const pipePath = join(root, 'a|b.txt');
    writeFileSync(pipePath, 'xy');

    const [probe] = parseRemoteProbeLines(execFileSync('sh', ['-c', buildRemoteProbeCommand([pipePath])]).toString(), [
      pipePath,
    ]);

    expect(probe?.realPath).toBe(pipePath);
    expect(probe?.size).toBe(2);
  });

  it('walks into a nested directory that exists', () => {
    const nested = join(root, 'sub');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'f.txt'), 'abc');

    const [probe] = parseRemoteProbeLines(
      execFileSync('sh', ['-c', buildRemoteProbeCommand([join(nested, 'f.txt')])]).toString(),
      [join(nested, 'f.txt')]
    );

    expect(probe?.size).toBe(3);
    expect(statSync(join(nested, 'f.txt')).size).toBe(3);
  });
});

describe('parseRemoteProbeLine', () => {
  it('parses a file line and converts mtime to milliseconds', () => {
    expect(parseRemoteProbeLine('f|1234|1700000000|/srv/case/a.png')).toEqual({
      realPath: '/srv/case/a.png',
      kind: 'file',
      size: 1234,
      mtimeMs: 1700000000 * 1000,
    });
  });

  it('keeps a path that itself contains the separator', () => {
    expect(parseRemoteProbeLine('f|7|0|/srv/ca|se/a b.txt')?.realPath).toBe('/srv/ca|se/a b.txt');
  });

  it('maps directories, other kinds and the not-found marker', () => {
    expect(parseRemoteProbeLine('d|0|5|/srv/case')?.kind).toBe('directory');
    expect(parseRemoteProbeLine('o|0|0|/srv/case/sock')?.kind).toBe('other');
    expect(parseRemoteProbeLine('n')).toBeNull();
    expect(parseRemoteProbeLine('')).toBeNull();
  });

  it('rejects malformed lines instead of inventing a path', () => {
    expect(parseRemoteProbeLine('f|1|2')).toBeNull();
    expect(parseRemoteProbeLine('x|1|2|/p')).toBeNull();
    expect(parseRemoteProbeLine('f|1|2|')).toBeNull();
  });
});

describe('parseRemoteProbeLines', () => {
  it('aligns the last N lines, so a login banner cannot shift the mapping', () => {
    const stdout = 'welcome to the remote box\nf|3|1|/srv/a.txt\nn\n';
    expect(parseRemoteProbeLines(stdout, ['/srv/a.txt', '/srv/b.txt'])).toEqual([
      { realPath: '/srv/a.txt', kind: 'file', size: 3, mtimeMs: 1000 },
      null,
    ]);
  });

  it('throws when the remote shell returned too little output', () => {
    expect(() => parseRemoteProbeLines('f|3|1|/srv/a.txt\n', ['/a', '/b'])).toThrow(RemoteFileAccessError);
  });
});

describe('buildRemoteReadCommand', () => {
  it('streams the whole file with cat', () => {
    expect(buildRemoteReadCommand("/srv/case/it's.mp4")).toBe("cat '/srv/case/it'\\''s.mp4'");
  });

  it('turns a byte range into a constant-memory tail | head', () => {
    expect(buildRemoteReadCommand('/srv/case/v.mp4', { start: 2, end: 5 })).toBe(
      "tail -c +3 '/srv/case/v.mp4' | head -c 4"
    );
  });

  it('covers the first byte of the file (tail -c +1, not +0)', () => {
    expect(buildRemoteReadCommand('/f', { start: 0, end: 0 })).toBe("tail -c +1 '/f' | head -c 1");
  });
});
