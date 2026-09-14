/**
 * @fileoverview Remote (SSH) file access for remote-SSH cases.
 *
 * A remote case's `workingDir` is an absolute path on ANOTHER host
 * (`Session.workingDir = RemoteCase.remotePath`, see docs/remote-sessions.md). Every
 * file route used to read it with local `fs`, which cannot work: the local
 * `realpathSync` in `validateSessionFilePath` fails first, so the request died as a
 * 404 "File not found" before a byte was read (#415). This module is the ONE place
 * that reads remote bytes, mirroring how `remote-hosts.ts` is the one place that
 * builds an ssh command line.
 *
 * Connection options come from `buildSshConnectionArgs()` — never a hand-built ssh
 * line (the COD-107 discipline in docs/remote-sessions.md) — so a proxied,
 * custom-port or jump-hosted case reaches its files with exactly the credentials the
 * launch used, and `BatchMode=yes` means a host that needs a passphrase fails fast
 * instead of hanging on a prompt nothing can answer.
 *
 * ⚠️ The path is the injection surface: it arrives from the browser (`?path=`). It is
 * always interpolated as a single `shellescape`d token, and the whole remote command
 * is itself shellescaped into the ssh line, so the local shell and the remote shell
 * each see one opaque argument. Never build a command here by concatenating a raw
 * path into the string.
 *
 * Read-only by design: previews, text reads and streaming. Writing to a remote file
 * is deliberately NOT implemented (docs/file-viewer-edit-plan.md §6), nor are the
 * office-conversion/thumbnail paths that would need the bytes on the server's disk.
 */

import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Readable } from 'node:stream';
import type { SessionRemote } from './types/session.js';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';

const execAsync = promisify(exec);

/**
 * Bound on the probe (realpath + stat) round trip. The connect itself is already
 * bounded by `buildSshConnectionArgs`'s default `-o ConnectTimeout=10`; this covers
 * a host that accepts the TCP connection and then never answers.
 */
const REMOTE_PROBE_TIMEOUT_MS = 20_000;

/** Bound on a buffered remote read (`cat`), on top of the caller's own size cap. */
const REMOTE_READ_TIMEOUT_MS = 30_000;

/** Slack over the caller's byte cap so a file exactly at the limit still fits. */
const READ_BUFFER_SLACK_BYTES = 64 * 1024;

/** Marker a probe prints when the path does not exist on the remote host. */
const NOT_FOUND_MARKER = 'n';

/** What a remote path turned out to be. `other` = symlink/socket/fifo/device. */
export type RemotePathKind = 'file' | 'directory' | 'other';

export interface RemoteProbe {
  /** The path with symlinks resolved on the REMOTE host. */
  realPath: string;
  kind: RemotePathKind;
  /** Size in bytes (0 for anything that is not a regular file). */
  size: number;
  /** mtime in ms since epoch (0 when the remote `stat` reported none). */
  mtimeMs: number;
}

/**
 * A remote file access failed for a reason that is NOT "the file is missing" —
 * unreachable host, timeout, ssh error, unexpected probe output. Callers map this to
 * a 5xx with the remote reason in the message; a missing file is reported separately
 * as `null`/404 so the two cannot be confused.
 */
export class RemoteFileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteFileAccessError';
  }
}

/**
 * Wrap a remote shell command in the shared, shellescaped ssh line.
 *
 * The single entry point for "run this on the remote host": connection args (port,
 * identity, jump host, SOCKS ProxyCommand, extra `-o`) all come from
 * `buildSshConnectionArgs`, and the command is ONE shellescaped token, so a path with
 * spaces, quotes or `$(…)` cannot escape into the ssh command line.
 */
export function buildRemoteFileCommand(remote: SessionRemote, shellCommand: string): string {
  return [...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(shellCommand)].join(' ');
}

/**
 * `realpath + stat + existence` for one or more paths, in a SINGLE ssh round trip.
 *
 * One call instead of three matters: without a shared connection (no ControlMaster)
 * every extra `ssh` is a fresh handshake, and the file routes need the path AND the
 * workspace root canonicalized to compare them.
 *
 * Each path emits exactly one line — `n` when it does not exist, otherwise
 * `kind|size|mtime|realPath` with `realPath` LAST so a path containing `|` still
 * parses (the earlier fields are fixed and the remainder is the path).
 *
 * Symlink resolution is portable on purpose: `readlink -f` where available (Linux,
 * macOS >= 12.3), else the POSIX `cd`/`pwd -P` fallback, which resolves the DIRECTORY
 * chain. Resolution is required here rather than optional: `isSensitivePath()`
 * demands an already-realpath'd input, so a remote read must not be able to reach a
 * blocked target through a symlink any more than a local one can.
 */
export function buildRemoteProbeCommand(paths: readonly string[]): string {
  const probes = paths.map((path) => `probe ${shellescape(path)}`).join('\n');
  return [
    'probe() {',
    '  p=$1',
    '  r=$(readlink -f "$p" 2>/dev/null) || r=$(cd "$(dirname "$p")" 2>/dev/null && printf %s/%s "$(pwd -P)" "$(basename "$p")")',
    '  [ -n "$r" ] || r=$p',
    `  if [ ! -e "$p" ]; then printf '%s\\n' ${NOT_FOUND_MARKER}; return; fi`,
    '  if [ -d "$r" ]; then t=d; elif [ -f "$r" ]; then t=f; else t=o; fi',
    '  s=0',
    '  if [ "$t" = f ]; then s=$(wc -c < "$r" 2>/dev/null | tr -d " "); [ -n "$s" ] || s=0; fi',
    '  m=$(stat -c %Y "$r" 2>/dev/null || stat -f %m "$r" 2>/dev/null || printf 0)',
    `  printf '%s|%s|%s|%s\\n' "$t" "$s" "$m" "$r"`,
    '}',
    probes,
  ].join('\n');
}

/** Parse one probe line. `null` for the not-found marker or anything malformed. */
export function parseRemoteProbeLine(line: string): RemoteProbe | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed || trimmed === NOT_FOUND_MARKER) return null;

  const parts = trimmed.split('|');
  if (parts.length < 4) return null;

  const [kindRaw, sizeRaw, mtimeRaw] = parts;
  const kind: RemotePathKind | null =
    kindRaw === 'f' ? 'file' : kindRaw === 'd' ? 'directory' : kindRaw === 'o' ? 'other' : null;
  if (!kind) return null;

  const realPath = parts.slice(3).join('|');
  if (!realPath) return null;

  const size = Number.parseInt(sizeRaw, 10);
  const mtimeSeconds = Number.parseInt(mtimeRaw, 10);
  return {
    realPath,
    kind,
    size: Number.isFinite(size) && size > 0 ? size : 0,
    mtimeMs: Number.isFinite(mtimeSeconds) && mtimeSeconds > 0 ? mtimeSeconds * 1000 : 0,
  };
}

/**
 * Parse the output of {@link buildRemoteProbeCommand} into one entry per requested
 * path, in order. Throws when the output cannot be one line per path — that means the
 * transport or the remote shell did something unexpected, and silently treating it as
 * "not found" would turn an infrastructure failure into a wrong 404.
 *
 * The LAST `paths.length` lines are used so a login banner or an eager rc-file `echo`
 * on the remote host cannot shift the alignment.
 */
export function parseRemoteProbeLines(stdout: string, paths: readonly string[]): Array<RemoteProbe | null> {
  const lines = stdout.split('\n').filter((line) => line !== '');
  if (lines.length < paths.length) {
    throw new RemoteFileAccessError('remote host returned no usable file information');
  }
  return lines.slice(-paths.length).map((line) => parseRemoteProbeLine(line));
}

/** Probe one or more remote paths. Entry is `null` for a path that does not exist. */
export async function remoteProbePaths(
  remote: SessionRemote,
  paths: readonly string[]
): Promise<Array<RemoteProbe | null>> {
  const command = buildRemoteFileCommand(remote, buildRemoteProbeCommand(paths));
  let stdout: string;
  try {
    const result = await execAsync(command, { timeout: REMOTE_PROBE_TIMEOUT_MS, maxBuffer: 64 * 1024 });
    stdout = result.stdout;
  } catch (err) {
    throw new RemoteFileAccessError(
      `remote host ${remote.label || remote.host} unreachable: ${describeExecError(err)}`
    );
  }
  return parseRemoteProbeLines(stdout, paths);
}

/** Read a whole remote file into memory, capped by `maxBytes`. */
export async function remoteReadFile(remote: SessionRemote, remotePath: string, maxBytes: number): Promise<Buffer> {
  const command = buildRemoteFileCommand(remote, `cat ${shellescape(remotePath)}`);
  try {
    const result = await execAsync(command, {
      timeout: REMOTE_READ_TIMEOUT_MS,
      maxBuffer: maxBytes + READ_BUFFER_SLACK_BYTES,
      encoding: 'buffer',
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch (err) {
    throw new RemoteFileAccessError(`failed to read remote file: ${describeExecError(err)}`);
  }
}

/**
 * Command that writes a remote file's bytes to stdout.
 *
 * ⚠️ Range reads use `tail -c +N | head -c L` (both POSIX, constant memory) because
 * the alternative — `dd bs=1` — issues one read syscall per byte and would make video
 * seeking unusable. The trade-off is that a `tail` failure (the file vanished
 * mid-request) reports `head`'s exit status, i.e. a short body on an already-sent
 * 206; the client retries. The uncompressed path (`cat`) reports its own failure
 * correctly, so the streaming error path is still covered by the normal case.
 */
export function buildRemoteReadCommand(remotePath: string, range?: { start: number; end: number }): string {
  const quoted = shellescape(remotePath);
  if (!range) return `cat ${quoted}`;
  const length = range.end - range.start + 1;
  return `tail -c +${range.start + 1} ${quoted} | head -c ${length}`;
}

export interface RemoteFileStream {
  /** The remote file's bytes, streamed from the ssh child's stdout. */
  stream: Readable;
  /**
   * Abort the transfer and reap the ssh child. The caller MUST call this when the
   * HTTP request ends — especially on a client disconnect — or the `ssh` process
   * keeps running (and holding a connection open) after nobody is reading it.
   */
  close(): void;
}

/**
 * Stream a remote file (optionally a byte range) as a Node Readable.
 *
 * Nothing is buffered in server memory: the bytes go from `ssh`'s stdout straight to
 * the HTTP response, which is what makes a multi-GB remote video cost one pipe.
 */
export function remoteCreateReadStream(
  remote: SessionRemote,
  remotePath: string,
  range?: { start: number; end: number }
): RemoteFileStream {
  const command = buildRemoteFileCommand(remote, buildRemoteReadCommand(remotePath, range));
  const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 2000) stderr += chunk.toString();
  });

  const stream = child.stdout;
  let ended = false;
  stream.on('end', () => {
    ended = true;
  });
  stream.on('error', () => {
    ended = true;
  });

  child.on('error', (err: Error) => {
    stream.destroy(err);
  });
  child.on('close', (code: number | null) => {
    // Only a truncated transfer is an error. A non-zero exit AFTER the body finished
    // (e.g. a signal delivered as the last byte was flushed) must not destroy an
    // already-complete response, or the browser reports a broken body for a file it
    // received in full.
    if (ended || code === 0 || code === null) return;
    const detail = stderr.trim().split('\n')[0];
    stream.destroy(new RemoteFileAccessError(`remote read failed (ssh exit ${code})${detail ? `: ${detail}` : ''}`));
  });

  return {
    stream,
    close(): void {
      if (!stream.destroyed) stream.destroy();
      child.kill('SIGTERM');
    },
  };
}

/** First useful line of an exec/stderr error, for a user-facing message. */
function describeExecError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const record = err as { stderr?: unknown; message?: unknown; code?: unknown; killed?: unknown };
    const stderr =
      typeof record.stderr === 'string' ? record.stderr : Buffer.isBuffer(record.stderr) ? String(record.stderr) : '';
    const line = stderr
      .split('\n')
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (line) return line;
    if (record.killed) return 'timed out';
    if (typeof record.message === 'string' && record.message.length > 0) return record.message;
    if (typeof record.code === 'string' || typeof record.code === 'number') return `ssh exit ${record.code}`;
  }
  return 'unknown error';
}
