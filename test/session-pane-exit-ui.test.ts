/**
 * @fileoverview The exited-agent badge on a session tab (Ark0N/Codeman#446).
 *
 * The server publishes `session.paneExit` when the agent inside a local tmux
 * pane has exited while `remain-on-exit` kept the pane. These cover the two
 * halves the browser owns: turning that field into a label, and getting the
 * label onto and off a tab.
 *
 * The incremental render path is the only one a live session ever reaches.
 * Going from live to exited adds and removes no tab, so the full rebuild never
 * runs for it, which is why `applyPaneExitBadge()` is a named function rather
 * than a block inside the render loop.
 *
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

describe('the exited-agent tab label', () => {
  const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const load = <T>(name: string) => {
    const source = appJs.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
    if (!source) throw new Error(`${name} not found in app.js`);
    return new Function(`${source}\nreturn ${name};`)() as T;
  };
  const paneExitLabel = load<(p: unknown) => string>('paneExitLabel');

  it('renders nothing for an unknown answer, which must never read as alive', () => {
    expect(paneExitLabel(undefined)).toBe('');
    expect(paneExitLabel(null)).toBe('');
  });

  it('names the exit code', () => {
    expect(paneExitLabel({ status: 137, at: 1 })).toBe('exited (137)');
  });

  it('shows a clean exit as 0 rather than hiding it', () => {
    expect(paneExitLabel({ status: 0, at: 1 })).toBe('exited (0)');
  });

  it('names a signal death, which the maintainer wants kept on screen', () => {
    expect(paneExitLabel({ signal: 9, at: 1 })).toBe('exited (signal 9)');
  });

  it('says only "exited" when tmux knew the pane died but not how', () => {
    // Measured on tmux 3.2a: a SIGKILLed pane reports neither status nor signal.
    // Showing that as "exited (0)" would make an unexplained death look clean.
    expect(paneExitLabel({ at: 1 })).toBe('exited');
  });
});

describe('the exited-agent badge in a tab', () => {
  // The incremental render path is the only one a live session reaches: going
  // from live to exited adds and removes no tab, so the full rebuild never runs
  // for it. These drive that path's DOM work against a real tab element.
  const appJs = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const source = [
    appJs.match(/function paneExitLabel\([\s\S]*?\n\}/)?.[0],
    appJs.match(/function applyPaneExitBadge\([\s\S]*?\n\}/)?.[0],
  ].join('\n');
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
  const applyPaneExitBadge = new Function('document', `${source}\nreturn applyPaneExitBadge;`)(dom.window.document) as (
    tab: unknown,
    paneExit: unknown
  ) => void;

  const makeTab = () => {
    const tab = dom.window.document.createElement('div');
    tab.className = 'session-tab';
    tab.innerHTML = '<span class="tab-name">w1-case</span>';
    return tab;
  };
  const badge = (tab: { querySelector: (s: string) => { textContent: string | null } | null }) =>
    tab.querySelector('.tab-exited-badge');

  it('draws no badge while the answer is unknown', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, undefined);
    expect(badge(tab)).toBeNull();
  });

  it('adds the badge after the name once the agent exits', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 137, at: 1 });
    expect(badge(tab)?.textContent).toBe('exited (137)');
    expect(tab.querySelector('.tab-name')?.nextElementSibling?.className).toBe('tab-exited-badge');
  });

  it('marks the badge data-i18n-skip, like the other generated status text', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    expect(badge(tab)?.hasAttribute('data-i18n-skip')).toBe(true);
  });

  it('updates the text in place rather than stacking a second badge', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    const first = badge(tab);
    applyPaneExitBadge(tab, { status: 137, at: 2 });
    expect(tab.querySelectorAll('.tab-exited-badge')).toHaveLength(1);
    expect(badge(tab)).toBe(first);
    expect(badge(tab)?.textContent).toBe('exited (137)');
  });

  it('marks the tab so the status dot can be quieted', () => {
    // The dot renders from `status`, which stays `idle` or `busy` for an exited
    // pane by design, so the tab carries the exit as a class and CSS does the
    // rest. Without it a green or pulsing dot sits beside the badge.
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    expect(tab.classList.contains('tab-agent-exited')).toBe(true);
  });

  it('unmarks the tab when the pane comes back', () => {
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    applyPaneExitBadge(tab, undefined);
    expect(tab.classList.contains('tab-agent-exited')).toBe(false);
  });

  it('never quiets a dot that an alert has claimed', () => {
    // A dot turning red or yellow because a session is blocked on a human
    // outranks "the agent exited", so the CSS excludes both alert classes by
    // hand rather than relying on the cascade.
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    const rules = css.match(/\.session-tab\.tab-agent-exited[^{]*\{/g) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule).toContain(':not(.tab-alert-action)');
      expect(rule).toContain(':not(.tab-alert-idle)');
    }
  });

  it('removes the badge when the pane comes back', () => {
    // The retraction half: a respawned pane must not keep reading "exited".
    const tab = makeTab();
    applyPaneExitBadge(tab, { status: 0, at: 1 });
    applyPaneExitBadge(tab, undefined);
    expect(badge(tab)).toBeNull();
  });

  it('is what the incremental render path calls', () => {
    expect(appJs).toContain('applyPaneExitBadge(tab, session.paneExit)');
  });
});
