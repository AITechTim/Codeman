/**
 * @fileoverview Frontend tests for the Custom Model Endpoint Profiles Run-menu
 * picker (docs/custom-model-endpoints-plan.md): the generated entries in
 * session-ui.js's `_refreshCustomModelRunOptions()` / `runCustomModelEntry()`.
 *
 * These are DOM-level facts that need no Playwright and no tmux — `runScripts:
 * "dangerously"` is used deliberately (this JSDOM only ever parses markup this
 * module itself generated, never live user input) so that a broken inline
 * `onclick` attribute shows up as a genuinely uncallable handler, the same way
 * it would in a real browser, rather than merely as a string this test parses
 * by eye. `test/admin-ui.test.ts` and `test/home-sessions.test.ts` are the
 * precedent for driving a real frontend module against a JSDOM window rather
 * than a live server.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const CONSTANTS_JS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf-8');
const SESSION_UI_JS = readFileSync(new URL('../src/web/public/session-ui.js', import.meta.url), 'utf-8');

function resp(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

/**
 * Boots a minimal CodemanApp instance with constants.js + session-ui.js
 * evaluated against a real JSDOM window, so escapeHtml and the picker's own
 * innerHTML-building code run exactly as they do in the browser.
 */
function bootApp(
  options: {
    customModelClis?: Array<{ id: string; label: string }>;
    hosts?: unknown;
    cliAvailable?: (id: string) => boolean;
    activeCase?: { location?: string } | null;
    settingsEnabled?: boolean;
  } = {}
) {
  const dom = new JSDOM(
    `<!doctype html><body>
      <select id="quickStartCase"><option value="testcase" selected>testcase</option></select>
      <input id="tabCount" value="1">
      <button id="runBtn"></button>
      <div id="runModeMenu">
        <div id="runModeCustomModelSep" style="display:none"></div>
        <div id="runModeCustomModelHeader" style="display:none"></div>
        <div id="runModeCustomModels"></div>
      </div>
      <div class="modal" id="customModelPickModal">
        <h3 id="customModelPickTitle"></h3>
        <p id="customModelPickHint"></p>
        <div id="customModelPickList"></div>
      </div>
    </body>`,
    { url: 'http://localhost/', runScripts: 'dangerously' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      CodemanApp: new () => any;
      __codemanCustomModelClis?: Array<{ id: string; label: string }>;
    };
  (win as unknown as { eval: (s: string) => void }).eval('window.CodemanApp = function CodemanApp() {};');
  (win as unknown as { eval: (s: string) => void }).eval(CONSTANTS_JS);
  (win as unknown as { eval: (s: string) => void }).eval(SESSION_UI_JS);

  win.__codemanCustomModelClis = options.customModelClis ?? [{ id: 'claude', label: 'Claude Code' }];

  const app = new win.CodemanApp();
  app.cases = options.activeCase ? [{ name: 'testcase', ...options.activeCase }] : [{ name: 'testcase' }];
  app.loadAppSettingsFromStorage = () => ({ customModelEndpointsEnabled: options.settingsEnabled ?? true });
  app.isCliAvailable = options.cliAvailable ?? (() => true);
  app.showToast = () => {};
  // Default no-op so a button's onclick (selectCustomModelEntry -> possibly
  // straight to runCustomModelEntry for a single-model host) never rejects
  // with "this.run is not a function"; tests of the launch itself override it.
  app.run = async () => {};
  // _apiJson unwraps the {success,data} envelope for real against a live
  // server; here it stands in for that, driven from a fixed `hosts` fixture
  // so these tests exercise the picker's OWN code, not the envelope helper.
  app._apiJson = async (path: string) => {
    if (path === '/api/model-endpoints') return options.hosts ?? [];
    return null;
  };
  return { dom, win, app };
}

describe('Custom Model Endpoint Profiles: Run-menu picker generation', () => {
  it('generates a real, clickable button per (capable CLI, endpoint) pair', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);

    const container = win.document.getElementById('runModeCustomModels')!;
    const buttons = container.querySelectorAll('button');
    expect(buttons.length).toBe(1);

    const btn = buttons[0] as unknown as HTMLButtonElement & { onclick: unknown };
    // The real bug: JSON.stringify's own double quotes terminate the
    // double-quoted onclick attribute at the first one, so btn.onclick comes
    // back null and the parsed attribute is garbage. With escapeHtml wrapping
    // each stringified argument, jsdom (which compiles inline handlers under
    // runScripts:"dangerously" exactly like a real browser) parses it as a
    // real, callable function.
    expect(typeof btn.onclick).toBe('function');

    win.app = app;
    expect(() => btn.onclick!(new (win as any).Event('click'))).not.toThrow();
  });

  it('escapes a model id containing HTML-significant characters instead of letting it break out of the tag', async () => {
    // modelId comes from the endpoint's OWN /v1/models reply, which this box
    // does not control — a live-HTML-injection vector if it ever reaches the
    // markup unescaped, distinct from (and on top of) the quoting bug above.
    const dangerousModel = '"><img src=x onerror=alert(1)>';
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: [dangerousModel] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);

    const container = win.document.getElementById('runModeCustomModels')!;
    // The injected markup must never have produced a live <img> element: if it
    // did, the attacker-controlled tag closed the button early and escaped
    // into sibling markup instead of staying inert string data.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelectorAll('button').length).toBe(1);
  });

  it('is hidden when the feature setting is off, even with capable CLIs and endpoints present', async () => {
    const { win, app } = bootApp({
      settingsEnabled: false,
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    expect(win.document.getElementById('runModeCustomModels')!.innerHTML).toBe('');
    expect((win.document.getElementById('runModeCustomModelSep') as HTMLElement).style.display).toBe('none');
  });

  it('is hidden for a remote or Docker active case, since the apply route refuses both', async () => {
    for (const location of ['remote', 'docker']) {
      const { win, app } = bootApp({
        activeCase: { location },
        hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
      });
      const menu = win.document.getElementById('runModeMenu')!;
      await app._refreshCustomModelRunOptions(menu);
      expect(win.document.getElementById('runModeCustomModels')!.innerHTML, location).toBe('');
    }
  });

  it('skips an endpoint with no discovered model and no default, rather than generating a dead entry', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'undiscovered', label: 'Not discovered yet', baseUrl: 'http://localhost:8080', models: [] }],
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    expect(win.document.getElementById('runModeCustomModels')!.innerHTML).toBe('');
  });

  it('omits a CLI the host does not have installed, matching the stock entries’ own gating', async () => {
    const { win, app } = bootApp({
      customModelClis: [
        { id: 'claude', label: 'Claude Code' },
        { id: 'codex', label: 'Codex' },
      ],
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
      cliAvailable: (id: string) => id === 'claude',
    });
    const menu = win.document.getElementById('runModeMenu')!;
    await app._refreshCustomModelRunOptions(menu);
    const container = win.document.getElementById('runModeCustomModels')!;
    expect(container.querySelectorAll('button').length).toBe(1);
    expect(container.textContent).toContain('Claude Code');
    expect(container.textContent).not.toContain('Codex');
  });
});

describe('Custom Model Endpoint Profiles: the "which model" picker', () => {
  it('launches straight away for a host with exactly one discovered model, no dialog', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3'] }],
    });
    let launched: unknown[] | null = null;
    app.runCustomModelEntry = async (...args: unknown[]) => {
      launched = args;
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    expect(launched).toEqual(['claude', 'llama-box', 'qwen3']);
    expect(win.document.getElementById('customModelPickModal')!.classList.contains('active')).toBe(false);
  });

  it('opens the picker for a host with more than one discovered model, rather than launching directly', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3', 'llama3'] }],
    });
    let launched = false;
    app.runCustomModelEntry = async () => {
      launched = true;
    };

    await app.selectCustomModelEntry('claude', 'llama-box');

    expect(launched).toBe(false);
    const modal = win.document.getElementById('customModelPickModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    const list = win.document.getElementById('customModelPickList')!;
    expect(list.querySelectorAll('button').length).toBe(2);
    expect(list.textContent).toContain('qwen3');
    expect(list.textContent).toContain('llama3');
  });

  it('always asks with 2+ models, even when a defaultModelId is set — the point is letting this launch differ', async () => {
    const { win, app } = bootApp({
      hosts: [
        {
          id: 'llama-box',
          label: 'llama.cpp',
          baseUrl: 'http://localhost:8080',
          models: ['qwen3', 'llama3'],
          defaultModelId: 'qwen3',
        },
      ],
    });
    await app.selectCustomModelEntry('claude', 'llama-box');
    const modal = win.document.getElementById('customModelPickModal')!;
    expect(modal.classList.contains('active')).toBe(true);
    // The default is marked, not auto-chosen.
    expect(win.document.getElementById('customModelPickList')!.textContent).toContain('Default');
  });

  it('picking a row in the modal closes it and launches with that exact model', async () => {
    const { win, app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://localhost:8080', models: ['qwen3', 'llama3'] }],
    });
    let launched: unknown[] | null = null;
    app.runCustomModelEntry = async (...args: unknown[]) => {
      launched = args;
    };
    win.app = app;

    await app.selectCustomModelEntry('claude', 'llama-box');
    const buttons = win.document.getElementById('customModelPickList')!.querySelectorAll('button');
    const llama3Btn = [...buttons].find((b) => b.textContent?.includes('llama3')) as unknown as HTMLButtonElement & {
      onclick: (e: unknown) => void;
    };
    expect(typeof llama3Btn.onclick).toBe('function');
    llama3Btn.onclick(new (win as any).Event('click'));

    expect(launched).toEqual(['claude', 'llama-box', 'llama3']);
    expect(win.document.getElementById('customModelPickModal')!.classList.contains('active')).toBe(false);
  });

  it('re-fetches the endpoint at click time rather than trusting anything cached from the menu render', async () => {
    // The background re-discovery sweep (server-side, every 5 minutes) or a
    // settings-panel edit can change the model list between opening the
    // dropdown and clicking a row — the picker must reflect what is current.
    let fetchCount = 0;
    const { win, app } = bootApp({});
    app._apiJson = async (path: string) => {
      if (path !== '/api/model-endpoints') return null;
      fetchCount += 1;
      return [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: ['qwen3', 'llama3', 'phi4'] }];
    };
    await app.selectCustomModelEntry('claude', 'llama-box');
    expect(fetchCount).toBe(1);
    expect(win.document.getElementById('customModelPickList')!.querySelectorAll('button').length).toBe(3);
  });

  it('toasts and does nothing when the endpoint has vanished by click time', async () => {
    const { app } = bootApp({ hosts: [] });
    let toastMessage: string | null = null;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };
    await app.selectCustomModelEntry('claude', 'ghost-endpoint');
    expect(toastMessage).toMatch(/no longer exists/i);
  });

  it('toasts and does nothing when the endpoint has zero discovered models by click time', async () => {
    const { app } = bootApp({
      hosts: [{ id: 'llama-box', label: 'llama.cpp', baseUrl: 'http://x', models: [] }],
    });
    let toastMessage: string | null = null;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };
    await app.selectCustomModelEntry('claude', 'llama-box');
    expect(toastMessage).toMatch(/no models discovered/i);
  });
});

describe('Custom Model Endpoint Profiles: applying a picked entry', () => {
  it('does not apply the endpoint to a session that was already open when the launch fails', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'already-open-session';
    // Simulate every run*() function's own documented behaviour: a declined or
    // failed launch handles its own error and returns normally without ever
    // changing activeSessionId — it does NOT throw and does NOT leave it null.
    app.run = async () => {};
    app._runInFlight = false;
    let applyCalled = false;
    app._api = async (path: string) => {
      if (path.includes('/custom-model')) applyCalled = true;
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(applyCalled).toBe(false);
    expect(app.activeSessionId).toBe('already-open-session');
  });

  it('applies the endpoint once run() actually produces a NEW active session', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const calls: Array<{ path: string; body: unknown }> = [];
    app._api = async (path: string, opts?: { body?: unknown }) => {
      calls.push({ path, body: opts?.body });
      return {
        ok: true,
        json: async () => ({ success: true, data: { customModel: { endpointId: 'llama-box' }, restarted: true } }),
      };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('/api/sessions/new-session/custom-model');
    expect(calls[0].body).toEqual({ endpointId: 'llama-box', modelId: 'qwen3' });
  });

  it('waits for the freshly launched session to go idle before applying, so its own boot activity is never mistaken for a busy turn', async () => {
    // Measured live: a just-launched CLI reports 'busy' for its own startup
    // (spinner, workspace-trust check) well before the apply call could
    // otherwise reach it, and the apply route's isBusy() guard correctly
    // refuses to restart a session mid-turn — which a fresh boot looks
    // exactly like from the outside. This pins the fix: wait for idle FIRST.
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const calls: string[] = [];
    app._apiJson = async (path: string) => {
      calls.push(path);
      if (path === '/api/model-endpoints') return [];
      return null; // the wait call's return value is unused — a timeout is a normal 200
    };
    app._api = async (path: string) => {
      calls.push(path);
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    const waitIndex = calls.findIndex((p) => p.includes('/wait?'));
    const applyIndex = calls.findIndex((p) => p.endsWith('/custom-model'));
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(calls[waitIndex]).toBe('/api/sessions/new-session/wait?until=idle&timeout=20000');
    expect(applyIndex).toBeGreaterThan(waitIndex);
  });

  it('surfaces the real server error in the toast on a failed apply, rather than a generic message', async () => {
    const { app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    app._api = async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'Custom model endpoints are not supported for remote (SSH) or Docker sessions yet',
      }),
    });
    let toastMessage: string | null = null;
    let toastType: string | null = null;
    app.showToast = (msg: string, type: string) => {
      toastMessage = msg;
      toastType = type;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(toastMessage).toContain('Custom model endpoints are not supported for remote (SSH) or Docker sessions yet');
    expect(toastType).toBe('error');
  });

  it('routes through run() itself, so the Run in-flight lock actually engages', async () => {
    // CLAUDE.md, Run launch synchronization: the lock exists so a double click
    // cannot create duplicate sessions. A hardcoded dispatch table bypassing
    // run() would never set _runInFlight, which is what this pins.
    const { app } = bootApp({});
    let sawInFlight = false;
    app.run = async function (this: typeof app) {
      if (this._runInFlight) return;
      this._runInFlight = true;
      sawInFlight = true;
      this._runInFlight = false;
    };
    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');
    expect(sawInFlight).toBe(true);
  });

  it('restores the previous _runMode after a one-off custom-model launch, never persisting it', async () => {
    const { app } = bootApp({});
    app._runMode = 'opencode';
    let modeDuringRun: string | undefined;
    app.run = async function (this: typeof app) {
      modeDuringRun = this._runMode;
    };
    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');
    expect(modeDuringRun).toBe('claude');
    expect(app._runMode).toBe('opencode');
  });
});

describe('Custom Model Endpoint Profiles: llama-swap model-swap confirmation and loading state', () => {
  function launchHarness(applyResponses: Array<Record<string, unknown>>) {
    const { win, app } = bootApp({});
    app.activeSessionId = 'old-session';
    app.run = async () => {
      app.activeSessionId = 'new-session';
    };
    const applyBodies: unknown[] = [];
    let call = 0;
    app._api = async (path: string, opts?: { body?: unknown }) => {
      if (path.endsWith('/custom-model')) {
        applyBodies.push(opts?.body);
        const data = applyResponses[Math.min(call, applyResponses.length - 1)];
        call += 1;
        return { ok: true, status: 200, json: async () => ({ success: true, data }) };
      }
      throw new Error(`unexpected _api call: ${path}`);
    };
    return { win, app, applyBodies };
  }

  it('confirming the native window.confirm() re-sends the apply with confirmed:true', async () => {
    const { win, app, applyBodies } = launchHarness([
      {
        requiresConfirmation: true,
        currentlyLoadedModel: 'llama3',
        affectedSessions: [{ id: 's2', name: 'w2-otherbox' }],
      },
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: true },
    ]);
    let confirmMessage: string | undefined;
    win.confirm = ((msg: string) => {
      confirmMessage = msg;
      return true;
    }) as typeof win.confirm;
    app._watchLlamaSwapLoading = async () => {}; // not under test here

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(confirmMessage).toContain('w2-otherbox');
    expect(confirmMessage).toContain('llama3');
    expect(confirmMessage).toContain('qwen3');
    expect(applyBodies).toEqual([
      { endpointId: 'llama-box', modelId: 'qwen3' },
      { endpointId: 'llama-box', modelId: 'qwen3', confirmed: true },
    ]);
  });

  it('cancelling window.confirm() keeps the native backend and never re-sends the apply', async () => {
    const { win, app, applyBodies } = launchHarness([
      { requiresConfirmation: true, currentlyLoadedModel: 'llama3', affectedSessions: [{ id: 's2', name: 'w2' }] },
    ]);
    win.confirm = (() => false) as typeof win.confirm;
    let toastMessage: string | undefined;
    app.showToast = (msg: string) => {
      toastMessage = msg;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(applyBodies).toHaveLength(1); // no second (confirmed) call
    expect(toastMessage).toMatch(/cancelled/i);
  });

  it('a successful apply with modelSwapInProgress kicks off the loading watcher', async () => {
    const { app } = launchHarness([
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: true },
    ]);
    let watched: unknown[] | null = null;
    app._watchLlamaSwapLoading = async (...args: unknown[]) => {
      watched = args;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(watched).toEqual(['llama-box', 'qwen3']);
  });

  it('a successful apply with no swap needed never starts the loading watcher', async () => {
    const { app } = launchHarness([
      { customModel: { endpointId: 'llama-box' }, restarted: true, modelSwapInProgress: false },
    ]);
    let watchCalled = false;
    app._watchLlamaSwapLoading = async () => {
      watchCalled = true;
    };

    await app.runCustomModelEntry('claude', 'llama-box', 'qwen3');

    expect(watchCalled).toBe(false);
  });
});

describe('Custom Model Endpoint Profiles: _watchLlamaSwapLoading polling', () => {
  // Driven with millisecond intervals (the function's own pollIntervalMs/maxWaitMs
  // params — real callers never pass them) rather than fake timers: this code runs
  // inside the JSDOM window's own realm (bootApp's `runScripts: "dangerously"` eval),
  // whose setTimeout is NOT the one vi.useFakeTimers() patches, so advancing fake
  // timers here would advance nothing and either hang or silently no-op.

  it('dismisses the loading toast as soon as the target model reports ready', async () => {
    const { app } = bootApp({});
    const toastCalls: Array<{ message: string; type: string }> = [];
    const dismissed: string[] = [];
    app.showToast = (message: string, type: string) => {
      toastCalls.push({ message, type });
      return { dismiss: () => dismissed.push(message), setMessage: () => {} };
    };
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 5, 200);

    expect(toastCalls[0].message).toMatch(/loading qwen3/i);
    expect(dismissed).toContain(toastCalls[0].message);
    expect(toastCalls.at(-1)?.message).toMatch(/ready/i);
  });

  it('gives up after the bounded wait and warns instead of polling forever', async () => {
    const { app } = bootApp({});
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
      return { dismiss: () => {}, setMessage: () => {} };
    };
    app._apiJson = async () => ({ isLlamaSwap: true, running: [{ model: 'something-else', state: 'ready' }] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 5, 30);

    expect(toastCalls.at(-1)).toMatch(/still waiting/i);
  });

  it('stops polling (without a warning) once the endpoint no longer reads as llama-swap', async () => {
    const { app } = bootApp({});
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
      return { dismiss: () => {}, setMessage: () => {} };
    };
    app._apiJson = async () => ({ isLlamaSwap: false, running: [] });

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 5, 200);

    expect(toastCalls).toHaveLength(1); // only the initial "Loading..." toast, no follow-up warning
  });

  it('keeps waiting through a transient status-fetch failure instead of giving up early', async () => {
    const { app } = bootApp({});
    const toastCalls: string[] = [];
    app.showToast = (message: string) => {
      toastCalls.push(message);
      return { dismiss: () => {}, setMessage: () => {} };
    };
    let call = 0;
    app._apiJson = async () => {
      call += 1;
      if (call === 1) return null; // transient failure
      return { isLlamaSwap: true, running: [{ model: 'qwen3', state: 'ready' }] };
    };

    await app._watchLlamaSwapLoading('llama-box', 'qwen3', 5, 200);

    expect(toastCalls.at(-1)).toMatch(/ready/i);
  });
});
