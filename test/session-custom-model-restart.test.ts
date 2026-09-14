/**
 * @fileoverview Custom Model Endpoint Profiles, the Session half of applying and
 * clearing a selection against a live pane (`Session.setCustomModel()` +
 * `Session.restartCli()`), pinned against the three ways the first cut broke a
 * working session:
 *
 * 1. Clearing did not clear. The injected vars reach the CLI via `tmux setenv`,
 *    which persists at the tmux-session level and is inherited by `respawn-pane`,
 *    so removing them from `_envOverrides` relaunched the CLI still pointed at the
 *    endpoint (and, for the configDir kinds, at a `HOME`/`CODEX_HOME` that had just
 *    been deleted). The retired keys must ride `RespawnPaneOptions.unsetEnvKeys`.
 * 2. Applying to a local claude session killed the pane: the relaunch was
 *    `claude --session-id <id>` and Claude refuses an id that already has a
 *    transcript, so it needs the `--resume <id> || --session-id <id>` shape the
 *    docker and remote pane commands use, i.e. a pinned resume id.
 * 3. pi/omp/grok wrote their config file and then launched without the `--model`
 *    that selects it, so the file was ignored.
 *
 * Drives a real `Session` against the in-memory tmux layer vitest substitutes,
 * spying on `respawnPane` to read the options the relaunch would get.
 * Port: N/A.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { MuxSession, SessionMode } from '../src/types.js';

const workingDir = join(homedir(), 'codeman-cases', 'custom-model-restart');
const sessions: Session[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.stop();
  rmSync(workingDir, { recursive: true, force: true });
});

function liveSession(mode: SessionMode, extra: Record<string, unknown> = {}) {
  mkdirSync(workingDir, { recursive: true });
  const mux = new TmuxManager();
  const muxSession: MuxSession = {
    sessionId: 'placeholder',
    muxName: 'codeman-cafe0001',
    pid: 1,
    createdAt: Date.now(),
    workingDir,
    mode,
    attached: false,
  };
  const session = new Session({ workingDir, mode, mux, useMux: true, muxSession, ...extra });
  sessions.push(session);
  vi.spyOn(mux, 'muxSessionExists').mockReturnValue(true);
  const respawn = vi.spyOn(mux, 'respawnPane').mockResolvedValue(4242);
  return { session, respawn };
}

const CLAUDE_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_DEFAULT_SONNET_MODEL'];
const claudeEnv = {
  ANTHROPIC_BASE_URL: 'http://box:8080',
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'q',
};

describe('clearing a selection unsets what it injected', () => {
  it('queues the retired keys for setenv -u on the next respawn and drops them from the overrides', async () => {
    const { session, respawn } = liveSession('claude', { envOverrides: { CLAUDE_CODE_KEEP: '1' } });
    session.setCustomModel({ endpointId: 'ep', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);

    const result = session.setCustomModel(undefined);
    expect(result.removedEnvKeys).toEqual(CLAUDE_KEYS);
    expect(session.customModel).toBeUndefined();

    expect(await session.restartCli()).toBe(true);
    const options = respawn.mock.calls[0][0];
    expect(options.unsetEnvKeys).toEqual(CLAUDE_KEYS);
    expect(options.envOverrides).toEqual({ CLAUDE_CODE_KEEP: '1' });

    // Drained once the respawn succeeded: the next relaunch has nothing to unset.
    respawn.mockClear();
    await session.restartCli();
    expect(respawn.mock.calls[0][0].unsetEnvKeys).toBeUndefined();
  });

  it('switching endpoints re-sets the shared keys instead of unsetting them', async () => {
    const { session, respawn } = liveSession('claude');
    session.setCustomModel({ endpointId: 'a', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);
    const next = { ...claudeEnv, ANTHROPIC_BASE_URL: 'http://other:8080' };
    session.setCustomModel({ endpointId: 'b', modelId: 'q', envKeys: CLAUDE_KEYS }, next);

    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.unsetEnvKeys).toBeUndefined();
    expect(options.envOverrides?.ANTHROPIC_BASE_URL).toBe('http://other:8080');
  });

  it('reports the previous config dir so the caller can delete it, and never leaks bookkeeping on the wire', () => {
    const { session } = liveSession('pi');
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'q', envKeys: ['HOME'], configDir: '/tmp/cfg-1', launchModel: 'custom/q' },
      { HOME: '/tmp/cfg-1' }
    );
    expect(session.customModel).toEqual({ endpointId: 'ep', modelId: 'q', label: undefined });
    expect(session.toState().customModel).toEqual({ endpointId: 'ep', modelId: 'q', label: undefined });
    expect(session.getCustomModelForPersist()).toEqual({
      endpointId: 'ep',
      modelId: 'q',
      label: undefined,
      envKeys: ['HOME'],
      configDir: '/tmp/cfg-1',
      launchModel: 'custom/q',
    });
    expect(session.setCustomModel(undefined).previousConfigDir).toBe('/tmp/cfg-1');
  });
});

describe('restartCli() must not kill a working pane', () => {
  it('claude: pins the live conversation id so the relaunch renders --resume <id> || --session-id <id>', async () => {
    const { session, respawn } = liveSession('claude');
    await session.restartCli();
    const options = respawn.mock.calls[0][0];
    expect(options.resumeSessionId).toBe(session.claudeSessionId);
    expect(options.resumeSessionId).toBe(session.id);
    // The pin is per-respawn: nothing about the session's own resume id changed.
    expect(session.toState().resumeSessionId).toBeUndefined();
  });

  it('claude: an explicit resume id from a resume-from-history launch wins over the pin', async () => {
    const RESUMED = '01a060f0-0361-7f91-abde-b283020db0d7';
    const { session, respawn } = liveSession('claude', { resumeSessionId: RESUMED });
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBe(RESUMED);
  });

  it('pi: no top-level resume pin, its resume id is minted by the CLI and lives in piConfig', async () => {
    const { session, respawn } = liveSession('pi');
    await session.restartCli();
    expect(respawn.mock.calls[0][0].resumeSessionId).toBeUndefined();
  });
});

describe('launchModel reaches the CLI through its own launch param', () => {
  it('pi: the selection forces piConfig.model on the respawn options, leaving the stored config alone', async () => {
    const { session, respawn } = liveSession('pi', { piConfig: { model: 'anthropic/claude-x', thinking: 'low' } });
    session.setCustomModel(
      { endpointId: 'ep', modelId: 'qwen3', envKeys: ['HOME'], configDir: '/tmp/cfg', launchModel: 'custom/qwen3' },
      { HOME: '/tmp/cfg' }
    );
    await session.restartCli();
    expect(respawn.mock.calls[0][0].piConfig).toEqual({ model: 'custom/qwen3', thinking: 'low' });
    // The user's own choice survives underneath, which is what a clear falls back to.
    expect(session.toState().piConfig).toEqual({ model: 'anthropic/claude-x', thinking: 'low' });

    session.setCustomModel(undefined);
    respawn.mockClear();
    await session.restartCli();
    expect(respawn.mock.calls[0][0].piConfig).toEqual({ model: 'anthropic/claude-x', thinking: 'low' });
  });

  it('grok: the block name lands in grokConfig.model', async () => {
    const { session, respawn } = liveSession('grok');
    session.setCustomModel(
      {
        endpointId: 'ep',
        modelId: 'qwen3',
        envKeys: ['GROK_HOME'],
        configDir: '/tmp/cfg',
        launchModel: 'codeman-custom',
      },
      { GROK_HOME: '/tmp/cfg' }
    );
    await session.restartCli();
    expect(respawn.mock.calls[0][0].grokConfig).toEqual({ model: 'codeman-custom' });
  });

  it('claude: a selection without a launchModel leaves the model param untouched', async () => {
    const { session, respawn } = liveSession('claude');
    session.setCustomModel({ endpointId: 'ep', modelId: 'q', envKeys: CLAUDE_KEYS }, claudeEnv);
    await session.restartCli();
    expect(respawn.mock.calls[0][0].model).toBeUndefined();
  });
});
