/**
 * @fileoverview Tests for the two custom-model IO-layer fixes on top of the pure builder
 * (docs/custom-model-endpoints-plan.md):
 *
 * 1. `contextLengthVar` — a discovered per-model context length reaches the actual
 *    session env (CLAUDE_CODE_MAX_CONTEXT_TOKENS), so a CLI stops assuming a large
 *    default window for an unrecognized custom model id and overflowing a much
 *    smaller real one.
 * 2. `configDirVar` — an isolated, empty config directory is created and pointed at
 *    (CLAUDE_CONFIG_DIR), so an injected API key never shares a directory with a
 *    stored claude.ai OAuth session; `projects` is symlinked back into the real
 *    config dir so the response viewer/subagent windows/Read My Mind keep working.
 *
 * Port: N/A (no server; filesystem-only, under a temp CODEMAN data dir from test/setup.ts).
 */
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCli } from '../src/config/cli-registry/index.js';
import { applyCustomModelInjection, customModelConfigDir } from '../src/custom-model-injection-apply.js';
import type { CustomModelEndpoint } from '../src/custom-model-injection.js';

const endpoint: CustomModelEndpoint = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'my-key',
};

function entryOrThrow(id: string) {
  const entry = getCli(id);
  if (!entry) throw new Error(`missing CLI registry entry: ${id}`);
  return entry;
}

const sessionsToClean: string[] = [];
afterEach(() => {
  for (const id of sessionsToClean.splice(0)) rmSync(customModelConfigDir(id), { recursive: true, force: true });
});

describe('applyCustomModelInjection: context length', () => {
  it('claude: passes a known context length through to CLAUDE_CODE_MAX_CONTEXT_TOKENS', () => {
    sessionsToClean.push('sess-ctx-1');
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', 'sess-ctx-1', 16384);
    expect(applied?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('16384');
    expect(applied?.envKeys).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS');
  });

  it('claude: omits the var entirely when the context length is unknown', () => {
    sessionsToClean.push('sess-ctx-2');
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', 'sess-ctx-2');
    expect(applied?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('deepseek: has no contextLengthVar declared, so a passed-in length is a no-op', () => {
    const applied = applyCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3', 'sess-ctx-3', 16384);
    expect(Object.keys(applied?.envOverrides ?? {}).sort()).toEqual(['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']);
  });
});

describe('applyCustomModelInjection: CLAUDE_CONFIG_DIR isolation', () => {
  it('claude: creates an isolated, empty config dir and points CLAUDE_CONFIG_DIR at it', () => {
    const sessionId = 'sess-cfgdir-1';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const expectedDir = customModelConfigDir(sessionId);
    expect(applied?.envOverrides.CLAUDE_CONFIG_DIR).toBe(expectedDir);
    expect(applied?.configDir).toBe(expectedDir);
    expect(existsSync(expectedDir)).toBe(true);
    // No credential/config files written into it — isolation, not a real config copy.
    const entries = readdirSync(expectedDir).filter((name) => name !== 'projects');
    expect(entries).toEqual([]);
  });

  it('claude: symlinks (or junctions) projects back to the real config dir so the response viewer keeps working', () => {
    const sessionId = 'sess-cfgdir-2';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const link = join(applied!.configDir!, 'projects');
    // Best-effort: only assert the link exists if it was actually created (the real
    // ~/.claude/projects may not exist on a bare CI box, in which case linking is skipped).
    if (existsSync(join(homedir(), '.claude', 'projects'))) {
      expect(existsSync(link)).toBe(true);
      expect(lstatSync(link).isSymbolicLink() || lstatSync(link).isDirectory()).toBe(true);
    }
  });

  it('claude: re-applying to the same session is idempotent (boot-recovery re-apply)', () => {
    const sessionId = 'sess-cfgdir-3';
    sessionsToClean.push(sessionId);
    const first = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    const second = applyCustomModelInjection(entryOrThrow('claude'), endpoint, 'qwen3', sessionId);
    expect(second?.configDir).toBe(first?.configDir);
    expect(existsSync(first!.configDir!)).toBe(true);
  });

  it('pi: configDir-kind CLIs are unaffected — no configDirVar concept for them', () => {
    const sessionId = 'sess-cfgdir-pi';
    sessionsToClean.push(sessionId);
    const applied = applyCustomModelInjection(entryOrThrow('pi'), endpoint, 'qwen3', sessionId);
    expect(applied?.envOverrides.HOME).toBe(customModelConfigDir(sessionId));
  });

  it('deepseek: no configDirVar declared, so no config dir is created at all', () => {
    const sessionId = 'sess-cfgdir-deepseek';
    const applied = applyCustomModelInjection(entryOrThrow('deepseek'), endpoint, 'qwen3', sessionId);
    expect(applied?.configDir).toBeUndefined();
    expect(existsSync(customModelConfigDir(sessionId))).toBe(false);
  });
});

describe('applyCustomModelInjection: pre-existing behavior unaffected', () => {
  it('opencode: still returns a plain env-kind result with no configDir', () => {
    const sessionId = 'sess-opencode-1';
    const applied = applyCustomModelInjection(entryOrThrow('opencode'), endpoint, 'qwen3', sessionId);
    expect(applied?.configDir).toBeUndefined();
    expect(applied?.envOverrides.OPENCODE_CONFIG_CONTENT).toBeTruthy();
  });

  it('antigravity: still undefined (unsupported)', () => {
    const applied = applyCustomModelInjection(entryOrThrow('antigravity'), endpoint, 'qwen3', 'sess-agy-1');
    expect(applied).toBeUndefined();
  });
});
