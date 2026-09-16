/**
 * @fileoverview The one IO wrapper around `custom-model-injection.ts`'s pure
 * `ConfigDirInjection` output — deliberately split out so that file, the
 * discovery routes, and `scripts/test-local-llm-harnesses.ts` (via tsx) can
 * all share EXACTLY one "write these files, merge this env" implementation.
 * Before this existed, the route and the standalone script each carried
 * their own copy of this logic, which is exactly the kind of drift the CLI
 * registry's "declare once, consume everywhere" design exists to prevent —
 * see docs/custom-model-endpoints-plan.md and the "dynamic to support
 * cli-registry changes" requirement it was written against.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { dataPath } from './config/instance.js';
import type { CliEntry } from './config/cli-registry/types.js';
import {
  buildCustomModelInjection,
  type ConfigDirInjection,
  type CustomModelEndpoint,
} from './custom-model-injection.js';

/** Where a session's isolated `configDir`-kind files live: never the user's real CLI config path. */
export function customModelConfigDir(sessionId: string): string {
  return join(dataPath('custom-model-configs'), sessionId);
}

/**
 * Writes a `ConfigDirInjection`'s files under `baseDir` and returns the full
 * envOverrides object a caller should merge into the session/process env
 * (the dir-redirect var plus any `extraEnv` the config file references by
 * name). Never touches anything outside `baseDir` — the caller is
 * responsible for choosing an isolated directory (never the user's real
 * `~/.codex`, `~/.pi`, etc.).
 *
 * pi and omp embed the API key literally in the file, so the tree is written
 * 0700/0600 like every other secret-bearing file under `~/.codeman`; the chmod
 * covers a re-apply onto a file that already exists (`mode` only applies at
 * creation).
 */
export function applyConfigDirInjection(baseDir: string, injection: ConfigDirInjection): Record<string, string> {
  for (const file of injection.files) {
    const filePath = join(baseDir, file.relPath);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, file.content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(filePath, 0o600);
  }
  return { [injection.dirEnvVar]: baseDir, ...injection.extraEnv };
}

/**
 * Real, shared Claude config directory Codeman's own host process runs under — honors
 * `CLAUDE_CONFIG_DIR` the same way `claude-credentials.ts`'s `claudeCredentialsPath()`
 * does, so the symlink below points at wherever `~/.claude/projects` actually lives
 * rather than assuming the plain default.
 */
function realClaudeConfigDir(): string {
  const configured = typeof process.env.CLAUDE_CONFIG_DIR === 'string' && process.env.CLAUDE_CONFIG_DIR.trim();
  return configured || join(homedir(), '.claude');
}

/**
 * Symlinks `<isolatedDir>/projects` back to the real, shared `~/.claude/projects`, so an
 * isolated `CLAUDE_CONFIG_DIR` (used to keep an injected API key away from a stored OAuth
 * session — see `configDirVar` on customModelInjection) doesn't also blind the response
 * viewer, subagent windows, and Read My Mind for that session (docs/wiki/Agent-CLIs.md).
 * Best-effort: a platform that refuses symlinks (unprivileged Windows without a junction
 * fallback working, e.g.) just keeps the pre-existing documented side effect instead of
 * failing the whole custom-model apply over a nice-to-have.
 */
function linkSharedProjectsDir(isolatedDir: string): void {
  const link = join(isolatedDir, 'projects');
  if (existsSync(link)) return; // already linked (idempotent re-apply) or real dir wrote one
  try {
    symlinkSync(join(realClaudeConfigDir(), 'projects'), link, platform() === 'win32' ? 'junction' : 'dir');
  } catch {
    // best-effort only — response viewer/subagent windows go blind for this session instead
  }
}

/** Best-effort recursive removal of a previously-written configDir. Never throws. */
export function removeConfigDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}

/** What applying an endpoint to a session yields, ready for `Session.setCustomModel()`. */
export interface AppliedCustomModel {
  envOverrides: Record<string, string>;
  envKeys: string[];
  configDir?: string;
  launchModel?: string;
}

/**
 * Compute (and for the `configDir` kind, write) everything a session needs to run
 * against `endpoint`/`modelId`. Returns undefined for a CLI with no mechanism.
 *
 * Idempotent on purpose: the boot-recovery path calls it again for a session that
 * was already pointed at an endpoint, so the config files are rewritten in place
 * (same content) and the env values, which are never persisted because they carry
 * the API key, are re-derived from the endpoint store instead.
 */
export function applyCustomModelInjection(
  entry: Pick<CliEntry, 'capabilities'>,
  endpoint: CustomModelEndpoint,
  modelId: string,
  sessionId: string,
  /** Discovered context-window size for `modelId`, if known — see `contextLengthVar`. */
  contextLength?: number
): AppliedCustomModel | undefined {
  const injection = buildCustomModelInjection(entry, endpoint, modelId, contextLength);
  if (injection.kind === 'unsupported') return undefined;
  if (injection.kind === 'env') {
    // `configDirVar` (claude's CLAUDE_CONFIG_DIR): point it at the same isolated,
    // per-session directory the `configDir` kind uses, but write no files into it — an
    // empty directory has no stored OAuth credential to conflict with the injected API
    // key, which is the whole point. Reusing the same path keyed by sessionId keeps this
    // idempotent across a boot-recovery re-apply, same as the configDir kind below.
    let envOverrides = injection.envOverrides;
    let configDir: string | undefined;
    if (injection.configDirVar) {
      configDir = customModelConfigDir(sessionId);
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      linkSharedProjectsDir(configDir);
      envOverrides = { ...envOverrides, [injection.configDirVar]: configDir };
    }
    return {
      envOverrides,
      envKeys: Object.keys(envOverrides),
      configDir,
      launchModel: injection.launchModel,
    };
  }
  const configDir = customModelConfigDir(sessionId);
  const envOverrides = applyConfigDirInjection(configDir, injection);
  return { envOverrides, envKeys: Object.keys(envOverrides), configDir, launchModel: injection.launchModel };
}
