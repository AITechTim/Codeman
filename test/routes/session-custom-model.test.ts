/**
 * @fileoverview Tests for POST /api/sessions/:id/custom-model (docs/custom-model-endpoints-plan.md
 * chunk 5 — applying/clearing a session's custom model endpoint + CLI restart).
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE_ENDPOINT: CustomModelHost = {
  id: 'ep1',
  label: 'llama.cpp box',
  baseUrl: 'http://192.168.1.50:8080',
  apiKey: 'k',
};

async function setup() {
  await writeCustomModelHosts(getDataDir(), [CLAUDE_ENDPOINT]);
  return createRouteTestHarness(registerSessionRoutes);
}

describe('POST /api/sessions/:id/custom-model', () => {
  beforeEach(async () => {
    await writeCustomModelHosts(getDataDir(), []);
  });

  it('applies an endpoint/model to a claude-mode session and restarts the CLI', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customModel).toEqual({ endpointId: 'ep1', modelId: 'qwen3', label: 'llama.cpp box' });
    expect(body.restarted).toBe(true);
    expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    expect(session.restartCli).toHaveBeenCalledTimes(1);

    // Verify the actual injected env vars via setCustomModel's captured call args.
    const [next, envOverrides] = session.setCustomModel.mock.calls[0];
    expect(next.envKeys).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'CLAUDE_CONFIG_DIR',
    ]);
    expect(envOverrides.ANTHROPIC_BASE_URL).toBe('http://192.168.1.50:8080');
    expect(envOverrides.ANTHROPIC_API_KEY).toBe('k');

    // CLAUDE_CONFIG_DIR isolates this session from a stored claude.ai OAuth login, and the
    // trust-dialog file it points at is pre-seeded so the injected key doesn't hit an
    // interactive "Detected a custom API key" prompt with nobody there to answer it.
    const isolatedDir = join(getDataDir(), 'custom-model-configs', 'test-session-1');
    expect(envOverrides.CLAUDE_CONFIG_DIR).toBe(isolatedDir);
    expect(next.configDir).toBe(isolatedDir);
    const trustFile = JSON.parse(readFileSync(join(isolatedDir, '.claude.json'), 'utf8'));
    expect(trustFile.customApiKeyResponses.approved).toEqual(['k']);
  });

  it('clears back to the native default', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { clear: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().customModel).toBeUndefined();
    expect(session.setCustomModel).toHaveBeenCalledWith(undefined);
    expect(session.restartCli).toHaveBeenCalledTimes(1);
  });

  it('404s for an unknown endpoint id', async () => {
    const { app, ctx } = await setup();
    ctx.sessions.get('test-session-1')!.mode = 'claude';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ghost', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });

  it('refuses a mode with no known custom-model mechanism (antigravity)', async () => {
    const { app, ctx } = await setup();
    ctx.sessions.get('test-session-1')!.mode = 'antigravity';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
  });

  it('refuses a remote (SSH) session before touching it: restartCli would only reattach the remote tmux', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.remote = { hostId: 'h1', remotePath: '/srv/case' };

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(res.json().error).toMatch(/remote/i);
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
  });

  it('refuses a Docker session the same way, for clear as well as apply', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.docker = { containerName: 'codeman-case' };

    for (const payload of [{ endpointId: 'ep1', modelId: 'qwen3' }, { clear: true }]) {
      const res = await app.inject({ method: 'POST', url: '/api/sessions/test-session-1/custom-model', payload });
      expect(res.json().success).toBe(false);
      expect(res.json().errorCode).toBe('INVALID_INPUT');
    }
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
  });

  it('pi: writes the config dir AND forces --model custom/<id>, since the file alone does not select the model', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3.5-0.8b' },
    });

    expect(res.statusCode).toBe(200);
    const [next, envOverrides] = session.setCustomModel.mock.calls[0];
    expect(next.launchModel).toBe('custom/qwen3.5-0.8b');
    expect(next.configDir).toBe(join(getDataDir(), 'custom-model-configs', 'test-session-1'));
    expect(envOverrides.HOME).toBe(next.configDir);
    const written = join(next.configDir, '.pi', 'agent', 'models.json');
    expect(existsSync(written)).toBe(true);
    // pi embeds the key literally, so the file is private to the server account.
    expect(statSync(written).mode & 0o777).toBe(0o600);
    expect(session.restartCli).toHaveBeenCalledTimes(1);
  });

  it('refuses a model id the CLI cannot carry on its command line instead of launching without it', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen 3 with spaces' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('INVALID_INPUT');
    expect(session.setCustomModel).not.toHaveBeenCalled();
    expect(session.restartCli).not.toHaveBeenCalled();
    // The config dir written before the check is cleaned up again.
    expect(existsSync(join(getDataDir(), 'custom-model-configs', 'test-session-1'))).toBe(false);
  });

  it('clear removes the previous config dir the session reports', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'pi';
    await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });
    const dir = join(getDataDir(), 'custom-model-configs', 'test-session-1');
    expect(existsSync(dir)).toBe(true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { clear: true },
    });
    expect(res.statusCode).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses to touch a busy session', async () => {
    const { app, ctx } = await setup();
    const session = ctx.sessions.get('test-session-1')!;
    session.mode = 'claude';
    session.isBusy = () => true;

    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions/test-session-1/custom-model',
      payload: { endpointId: 'ep1', modelId: 'qwen3' },
    });

    expect(res.json().success).toBe(false);
    expect(res.json().errorCode).toBe('SESSION_BUSY');
    expect(session.setCustomModel).not.toHaveBeenCalled();
  });
});
