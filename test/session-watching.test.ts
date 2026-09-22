/**
 * The badge a session wears while work it started in the background is still running.
 *
 * The bug this pins: an agent that arms a monitor, backgrounds a shell or hands work to a
 * cloud session is told to end its turn, so the pane falls quiet, Claude Code's idle
 * notification arrives a minute later, and every Codeman surface files the session under
 * NEEDS YOU. Nothing wants the user there. The CLI itself says so on the last row of its
 * screen (`⏵⏵ bypass permissions on · 1 monitor · ← for agents`), and reading that row is
 * what tells a session waiting for its own background work from one waiting for a human.
 *
 * The pane fixtures below are verbatim captures (`tmux -L codeman capture-pane -p`) from a
 * live Claude Code 2.1.278 session on 2026-09-21.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { getCli } from '../src/config/cli-registry/index.js';
import { compileVersionRegex } from '../src/config/cli-registry/patterns.js';
import {
  watchingLabel,
  WATCHING_TAIL_LINES,
  MAX_WATCHING_LABEL_CHARS,
  IDLE_SILENCE_MS,
} from '../src/session-activity.js';

/** The registry's own pattern for Claude, which is what every consumer runs. */
const CLAUDE_WATCHING = compileVersionRegex(getCli('claude')!.capabilities.workDetect!.watchingLine!)!;

/** The bottom of a Claude pane: composer, the user's status line, the footer row. */
function pane(footer: string, body = ''): string {
  return (
    body +
    '╭──────────────────────────────────────╮\n' +
    '│ ❯                                    │\n' +
    '╰──────────────────────────────────────╯\n' +
    '  ~/innovi/gtd-board [main] Opus 5 ctx: 11%\n' +
    `  ${footer}\n`
  );
}

const WITH_MONITOR = pane('⏵⏵ bypass permissions on · 1 monitor · ← for agents');
const WITH_SHELL = pane('⏵⏵ bypass permissions on · 1 shell · ← for agents');
const NOTHING_RUNNING = pane('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents');

/** A composer repaint: the frame Claude ships roughly once a second while working. */
const COMPOSER_REPAINT =
  '\x1b[31;1H\x1b[38;5;246m❯\xa0\x1b[39m\x1b[0m\x1b[33;1H  \x1b[38;5;246mOpus 5  in:143,699 out:669  ctx:14%\x1b[39m';

type SessionInternals = {
  _handleTerminalOutput(data: string): void;
  _detectInteractiveActivity(data: string): void;
};

/** One PTY chunk, exactly as the interactive handler sees it. */
function feed(session: Session, data: string): void {
  const internals = session as unknown as SessionInternals;
  internals._handleTerminalOutput(data);
  internals._detectInteractiveActivity(data);
}

/** A session whose mux reports a fixed (or scripted) screen for the pane probe to read. */
function withFakePane(screen: string | (() => string), mode: 'claude' | 'codex' = 'claude'): Session {
  const read = typeof screen === 'function' ? screen : () => screen;
  const mux = {
    isAvailable: () => true,
    capturePaneText: () => read(),
  } as unknown as NonNullable<ConstructorParameters<typeof Session>[0]>['mux'];
  return new Session({
    workingDir: '/tmp',
    mode,
    mux,
    muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
  } as ConstructorParameters<typeof Session>[0]);
}

/** Run one turn and let it end, which is when the probe reads the screen. */
function runAndSettle(session: Session): void {
  for (let i = 0; i < 3; i++) {
    feed(session, COMPOSER_REPAINT);
    vi.advanceTimersByTime(1000);
  }
  vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);
}

describe('watchingLabel', () => {
  it('reads the label off the footer row', () => {
    expect(watchingLabel(WITH_MONITOR, CLAUDE_WATCHING)).toBe('1 monitor');
    expect(watchingLabel(WITH_SHELL, CLAUDE_WATCHING)).toBe('1 shell');
  });

  it('reads every kind of background work the CLI names', () => {
    const labels = [
      '2 monitors',
      '3 shells',
      '1 cloud session',
      '2 cloud sessions',
      '1 local agent',
      '4 background tasks',
      '1 MCP task',
      '1 background dynamic workflow',
      '2 remote dynamic workflows',
      '1 Artifact comment monitor',
      '2 teams',
    ];
    for (const label of labels) {
      expect(watchingLabel(pane(`⏵⏵ bypass permissions on · ${label} · ← for agents`), CLAUDE_WATCHING)).toBe(label);
    }
  });

  it('says nothing about a pane that is running nothing', () => {
    expect(watchingLabel(NOTHING_RUNNING, CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel('', CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(null, CLAUDE_WATCHING)).toBeNull();
  });

  it('ignores the same words in the transcript above the composer', () => {
    // The whole reason the search is confined to the foot of the screen: a session that
    // PRINTS "1 monitor" (this one has been discussing exactly that) is not running one.
    const transcript =
      '> does Codeman know about watching?\n' +
      '⏺ The footer says · 1 monitor · while a monitor is armed, and · 2 shells · for\n' +
      '  backgrounded commands. Codeman reads neither today.\n' +
      '  Nothing else on the screen means background work is running.\n';
    expect(watchingLabel(pane('⏵⏵ bypass permissions on · ← for agents', transcript), CLAUDE_WATCHING)).toBeNull();
  });

  it('looks no further up the screen than the tail it declares', () => {
    const chip = '⏵⏵ bypass permissions on · 1 monitor · ← for agents';
    const below = Array(WATCHING_TAIL_LINES).fill('  still here').join('\n');
    // Blank lines are dropped before the tail is taken, so a pane padded with them must
    // still read its own footer.
    expect(watchingLabel(`${chip}\n\n\n\n\n\n`, CLAUDE_WATCHING)).toBe('1 monitor');
    expect(watchingLabel(`${chip}\n${below}\n`, CLAUDE_WATCHING)).toBeNull();
  });

  it('refuses a label the footer did not separate, which is the injection guard', () => {
    // The pattern anchors on the `·` the footer joins its items with. Without that
    // anchor an agent could silence its own idle alert by printing the words, since the
    // only rows it cannot write are the footer and the status line.
    expect(watchingLabel(pane('1 monitor'), CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(pane('running 2 shells for the build'), CLAUDE_WATCHING)).toBeNull();
    expect(watchingLabel(pane('⏵⏵ bypass permissions on · 1 monitor'), CLAUDE_WATCHING)).toBe('1 monitor');
  });

  it('reads a coloured footer, because a capture may carry ANSI', () => {
    const coloured = pane('\u001b[2m⏵⏵ bypass permissions on\u001b[0m · \u001b[36m1 monitor\u001b[0m · ← for agents');
    expect(watchingLabel(coloured, CLAUDE_WATCHING)).toBe('1 monitor');
  });

  it('caps the label, because it ends up on a badge and in an approval card', () => {
    const long = `· ${'9'.repeat(MAX_WATCHING_LABEL_CHARS * 2)} monitors`;
    const label = watchingLabel(pane(`⏵⏵ bypass permissions on ${long} · ← for agents`), CLAUDE_WATCHING);
    expect(label?.length).toBe(MAX_WATCHING_LABEL_CHARS);
  });

  it('survives a pattern handed to it with the global flag set', () => {
    // compileVersionRegex() never sets `g`, but a test or a reloaded config might, and a
    // sticky lastIndex would make the same screen match every other call.
    const global = new RegExp(CLAUDE_WATCHING.source, 'g');
    expect(watchingLabel(WITH_MONITOR, global)).toBe('1 monitor');
    expect(watchingLabel(WITH_MONITOR, global)).toBe('1 monitor');
  });
});

describe('Session.watching', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('carries what the pane reported once the turn ends', () => {
    vi.useFakeTimers();
    const session = withFakePane(WITH_MONITOR);
    expect(session.watching).toBeNull();

    runAndSettle(session);

    expect(session.status).toBe('idle');
    expect(session.watching).toBe('1 monitor');
  });

  it('lets the badge go when the background work is over', () => {
    vi.useFakeTimers();
    const screen = { text: WITH_MONITOR };
    const session = withFakePane(() => screen.text);

    runAndSettle(session);
    expect(session.watching).toBe('1 monitor');

    screen.text = NOTHING_RUNNING;
    runAndSettle(session);
    expect(session.watching).toBeNull();
  });

  it('keeps its last answer when the screen cannot be read', () => {
    vi.useFakeTimers();
    const screen: { text: string | null } = { text: WITH_MONITOR };
    const session = withFakePane(() => screen.text as string);

    runAndSettle(session);
    expect(session.watching).toBe('1 monitor');

    // A capture that fails is not evidence that nothing is running, which is the same
    // rule the working probe applies to its own null.
    screen.text = null;
    runAndSettle(session);
    expect(session.watching).toBe('1 monitor');
  });

  it('reports nothing for a CLI whose footer nobody has characterised', () => {
    vi.useFakeTimers();
    expect(getCli('codex')?.capabilities.workDetect?.watchingLine).toBeUndefined();
    // Codex draws its own composer glyph, so this session settles the same way; what it
    // must not do is read Claude's footer on a screen that is not Claude's.
    const session = withFakePane(WITH_MONITOR, 'codex');

    for (let i = 0; i < 3; i++) {
      feed(session, '\x1b[31;1H\x1b[38;5;246m›\xa0\x1b[39m\x1b[0m');
      vi.advanceTimersByTime(1000);
    }
    vi.advanceTimersByTime(IDLE_SILENCE_MS + 2000);

    expect(session.watching).toBeNull();
  });

  it('rides along on the payload every session surface reads', () => {
    vi.useFakeTimers();
    const session = withFakePane(WITH_SHELL);
    runAndSettle(session);

    expect(session.toLightDetailedState().watching).toBe('1 shell');
  });
});

describe('the registry pattern Claude declares', () => {
  it('is one the config-regex guard accepts', () => {
    // Same guard as `workingLine`: ~/.codeman/clis.json can set this field, and the
    // compiled pattern runs over a pane capture on a timer.
    expect(compileVersionRegex(getCli('claude')!.capabilities.workDetect!.watchingLine!)).not.toBeNull();
  });

  it('does not fire on the status line a user configured', () => {
    // Plan-usage and context figures live one row above the footer and carry numbers.
    const statusLine = '  ~/innovi/gtd-board [main] Opus 5 (1M context) high ctx: 10% 5h: 48% (32m) 7d: 15% (6d10h)';
    expect(CLAUDE_WATCHING.test(statusLine)).toBe(false);
  });
});
