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

import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  sessionId: string
): AppliedCustomModel | undefined {
  const injection = buildCustomModelInjection(entry, endpoint, modelId);
  if (injection.kind === 'unsupported') return undefined;
  if (injection.kind === 'env') {
    return {
      envOverrides: injection.envOverrides,
      envKeys: Object.keys(injection.envOverrides),
      launchModel: injection.launchModel,
    };
  }
  const configDir = customModelConfigDir(sessionId);
  const envOverrides = applyConfigDirInjection(configDir, injection);
  return { envOverrides, envKeys: Object.keys(envOverrides), configDir, launchModel: injection.launchModel };
}
