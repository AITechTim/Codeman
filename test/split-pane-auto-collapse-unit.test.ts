// test/split-pane-auto-collapse-unit.test.ts
// Port: N/A (no server/browser — loaded via `vm`, like session-close-fallback.test.ts).
//
// Fast, CI-visible unit coverage for the `_onSessionDeleted` prototype patch in
// terminal-split.js (whole-branch review finding I6). The "Pane B ends" branch
// already has real-Chromium coverage in test/split-pane-auto-collapse.browser.test.ts,
// but that suite is excluded from `npm test` (see Testing in CLAUDE.md), and the
// "Pane A ends, Pane B gets promoted" branch had NO coverage anywhere — it is the
// one whose correctness depends on exact ordering: `_splitSessionId` must be
// captured BEFORE `closeSplitPane()` runs (which nulls it), or the promoted
// session id is lost. This file pins that ordering plus the sibling branches
// (Pane B ends, unrelated session ends) so a regression fails in the normal CI
// gate rather than only in the browser suite nobody runs by default.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadCodemanAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const terminalSplitSrc = readFileSync(resolve(dir, 'terminal-split.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    window: {},
  });
  // A minimal fake CodemanApp — terminal-split.js only needs `_onSessionDeleted`
  // and `selectSession` to already exist on the prototype (it wraps both), and
  // neither wrapped body executes at module-load time (only inside method
  // calls), so no xterm/WebSocket/CodemanSplitPane globals are needed here.
  const fakeAppSrc = `
    class CodemanApp {
      _onSessionDeleted(data) {
        (this.__originalDeletedCalls ??= []).push(data);
      }
      selectSession(id) {
        (this.__originalSelectSessionCalls ??= []).push(id);
      }
    }
  `;
  vm.runInContext(`${fakeAppSrc}\n${terminalSplitSrc}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp as {
    prototype: {
      _onSessionDeleted: (this: unknown, data: { id: string }) => unknown;
    };
  };
}

const CodemanApp = loadCodemanAppClass();

type TestApp = {
  activeSessionId: string | null;
  _splitSessionId: string | null;
  _splitPane: { destroy: ReturnType<typeof vi.fn> } | null;
  _closingSessions: Set<string>;
  closeSplitPane: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  __originalDeletedCalls?: Array<{ id: string }>;
};

/** A split-active instance: Pane A === activeSessionId, Pane B === _splitSessionId. */
function makeSplitActiveApp(): TestApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
  app.activeSessionId = 'session-a';
  app._splitSessionId = 'session-b';
  app._splitPane = { destroy: vi.fn() };
  // Empty by default: the app's OWN closeSession() is not mid-await for this
  // delete, so the promotion below is expected to fire. See the dedicated
  // test further down for the non-empty (_closingSessions owns it) case.
  app._closingSessions = new Set();
  // closeSplitPane is mocked but mirrors the REAL implementation's one
  // observable side effect relevant here: it nulls _splitPane/_splitSessionId.
  // If the wrapper captured _splitSessionId AFTER calling closeSplitPane
  // instead of before, this would surface as selectSession(undefined) below.
  app.closeSplitPane = vi.fn(() => {
    app._splitPane = null;
    app._splitSessionId = null;
  });
  app.selectSession = vi.fn();
  return app;
}

describe('terminal-split.js _onSessionDeleted wrapper (I6)', () => {
  it('Pane A ends: closes the split and promotes Pane B via selectSession(ORIGINAL splitSessionId)', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    // Pinned ordering: selectSession must receive the id _splitSessionId held
    // BEFORE closeSplitPane ran (which nulls it), not whatever it holds after.
    // { auto: true } because this is an app-driven promotion, not the user
    // clicking a tab — it must not spend the promoted session's idle alert.
    expect(app.selectSession).toHaveBeenCalledWith('session-b', { auto: true });
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane B ends: closes the split without promoting anything', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-b' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-b' }]);
  });

  it('an unrelated session ending leaves the split untouched', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-c' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app._splitPane).not.toBeNull();
    expect(app._splitSessionId).toBe('session-b');
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-c' }]);
  });

  it('the original _onSessionDeleted always fires, split-active or not', () => {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
    app.activeSessionId = 'session-a';
    app._splitSessionId = null;
    app._splitPane = null;
    app._closingSessions = new Set();
    app.closeSplitPane = vi.fn();
    app.selectSession = vi.fn();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane A ends via the user closing its OWN tab: still collapses the split, but skips the promotion', () => {
    // closeSession() (app.js) adds the id to _closingSessions BEFORE awaiting
    // the delete, then owns the follow-up selection itself once it lands —
    // selecting Pane B's session here too would race it for which tab wins.
    const app = makeSplitActiveApp();
    app._closingSessions.add('session-a');

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });
});
