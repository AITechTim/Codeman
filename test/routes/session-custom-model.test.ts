/**
 * @fileoverview Tests for POST /api/sessions/:id/custom-model (docs/custom-model-endpoints-plan.md
 * chunk 5 — applying/clearing a session's custom model endpoint + CLI restart).
 * Port: N/A (app.inject, no real port needed)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';
import { createMockSession } from '../mocks/index.js';
import { getDataDir } from '../../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../../src/custom-model-hosts.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { webviewFetch } from '../../src/web/webview-egress.js';

// Every apply now also checks llama-swap's `GET /running` (session-routes.ts) before
// applying — without this mock every test in this file would make a REAL network request
// to the fake 192.168.1.50 endpoint below and wait out its 5s timeout. Defaults to a plain
// 404 (reads as "not llama-swap", exercising none of the new conflict-check tests below),
// overridden per-test where the llama-swap behavior itself is what's under test.
vi.mock('../../src/web/webview-egress.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/web/webview-egress.js')>(
    '../../src/web/webview-egress.js'
  );
  return { ...actual, webviewFetch: vi.fn() };
});
const fetchMock = vi.mocked(webviewFetch);

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
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));
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

  describe('llama-swap conflict check (llama.cpp runs one model at a time)', () => {
    function mockRunning(running: Array<{ model: string; state: string }>) {
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') return new Response(JSON.stringify({ running }), { status: 200 });
        throw new Error(`unexpected request in this test: ${url.href}`);
      });
    }

    it('applies straight away when the requested model is already loaded', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      mockRunning([{ model: 'qwen3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().success).not.toBe(false);
      expect(res.json().modelSwapInProgress).toBe(false);
      expect(ctx.sessions.get('test-session-1')!.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('applies straight away when a swap is needed but nothing else is using the loaded model, flagging modelSwapInProgress', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().success).not.toBe(false);
      expect(res.json().modelSwapInProgress).toBe(true);
      expect(ctx.sessions.get('test-session-1')!.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('asks for confirmation instead of applying when another session is actively using the currently loaded model', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.name = 'w2-otherbox';
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      const body = res.json();
      expect(body.success).not.toBe(false);
      expect(body.requiresConfirmation).toBe(true);
      expect(body.currentlyLoadedModel).toBe('llama3');
      expect(body.affectedSessions).toEqual([{ id: 'other-session', name: 'w2-otherbox' }]);
      // Nothing actually applied yet — this call only asked, it did not switch.
      expect(session.setCustomModel).not.toHaveBeenCalled();
      expect(session.restartCli).not.toHaveBeenCalled();
    });

    it('applies once confirmed, skipping the conflict check the second time', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3', confirmed: true },
      });

      const body = res.json();
      expect(body.requiresConfirmation).toBeUndefined();
      expect(body.modelSwapInProgress).toBe(true);
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
      expect(session.restartCli).toHaveBeenCalledTimes(1);
    });

    it('a session pointed at the SAME endpoint but a DIFFERENT (not-currently-loaded) model is not treated as affected', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'some-other-model' }; // not the loaded one
      ctx.sessions.set('other-session', other);
      mockRunning([{ model: 'llama3', state: 'ready' }]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().requiresConfirmation).toBeUndefined();
      expect(session.setCustomModel).toHaveBeenCalledTimes(1);
    });

    it('not llama-swap (plain llama.cpp/OpenAI-compatible server, no /running) — never checked, applies straight away', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      fetchMock.mockResolvedValue(new Response('not found', { status: 404 }));

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });

      expect(res.json().modelSwapInProgress).toBe(false);
      expect(res.json().requiresConfirmation).toBeUndefined();
    });
  });

  describe('triggering the actual llama-swap load (not just watching for it)', () => {
    it('sends a real inference request naming the target model when it is not already loaded and ready', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      const chatCalls: unknown[] = [];
      fetchMock.mockImplementation(async (url: URL, init?: { body?: unknown }) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'llama3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalls.push(JSON.parse(init!.body as string));
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the fire-and-forget trigger settle

      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]).toMatchObject({ model: 'qwen3', max_tokens: 1 });
    });

    it('never sends a load-trigger request when the target model is already loaded and ready', async () => {
      const { app, ctx } = await setup();
      ctx.sessions.get('test-session-1')!.mode = 'claude';
      let chatCalled = false;
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'qwen3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalled = true;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(chatCalled).toBe(false);
    });

    it('never sends a load-trigger request while confirmation is still pending', async () => {
      const { app, ctx } = await setup();
      const session = ctx.sessions.get('test-session-1')!;
      session.mode = 'claude';
      const other = createMockSession('other-session');
      other.customModel = { endpointId: 'ep1', modelId: 'llama3' };
      ctx.sessions.set('other-session', other);
      let chatCalled = false;
      fetchMock.mockImplementation(async (url: URL) => {
        if (url.pathname === '/running') {
          return new Response(JSON.stringify({ running: [{ model: 'llama3', state: 'ready' }] }), { status: 200 });
        }
        if (url.pathname === '/v1/chat/completions') {
          chatCalled = true;
          return new Response(JSON.stringify({ choices: [] }), { status: 200 });
        }
        throw new Error(`unexpected request in this test: ${url.href}`);
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/custom-model',
        payload: { endpointId: 'ep1', modelId: 'qwen3' },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.json().requiresConfirmation).toBe(true);
      expect(chatCalled).toBe(false);
    });
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
