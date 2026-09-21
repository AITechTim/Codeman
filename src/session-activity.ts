/**
 * @fileoverview Pure working/idle heuristics for a Claude interactive pane.
 *
 * Split out of `session.ts` so the thresholds and the state math are unit
 * testable without a PTY (same reasoning as `session-order.ts` /
 * `usage-limit-patterns.ts`).
 *
 * **Why activity and not the status line.** Claude Code's working indicator is
 * `✻ Actualizing… (13m 23s · ↓ 47.5k tokens)`, where the glyph animates through
 * `· ✢ ✳ ∗ ✻ ✽` and the gerund is randomized per turn. Neither the braille
 * spinner (`SPINNER_PATTERN`) nor the old keyword list (`Thinking|Writing|
 * Reading|Running`) matches any of that, so the pane looked idle for a whole
 * turn. Matching the new line does not rescue the stream either: tmux ships
 * PARTIAL repaints, so measured on a live worker the complete line reached the
 * PTY roughly once every 20 seconds, while the composer's `❯` (which is what
 * ARMS idle detection) arrived every single second.
 *
 * What is left is the one thing measured to separate the two states cleanly: a
 * working pane repaints, an idle pane emits nothing at all. Sampled once per
 * second for 12s across six live sessions, the two working ones produced output
 * in 12/12 windows and the four idle ones in 0/12.
 */

/**
 * A gap longer than this ends a run of continuous output. Claude repaints at
 * least once a second while working, so this leaves generous headroom.
 */
export const ACTIVITY_GAP_MS = 2000;

/**
 * Continuous output for this long means the pane is working. Long enough that a
 * one-off repaint (an update-check line, a rotating tip) cannot reach it.
 */
export const WORKING_STREAK_MS = 2000;

/**
 * Silence for this long is what confirms the pane really went idle. Must stay
 * above ACTIVITY_GAP_MS, or a pause between two repaints of one turn would
 * read as the end of the turn.
 */
export const IDLE_SILENCE_MS = 2500;

/** How often a pending idle confirmation re-checks a pane that is still noisy. */
export const IDLE_RECHECK_MS = 500;

/**
 * Floor between two pane probes for one session. The probe shells out to tmux,
 * so this is what keeps a screenful of busy sessions from turning idle detection
 * into a subprocess storm.
 */
export const PANE_PROBE_MIN_INTERVAL_MS = 1500;

/**
 * How long to wait before looking again at a pane the probe just called working.
 * Claude can sit silent for tens of seconds inside one tool call, so this is the
 * cadence that carries a long quiet turn, so it is deliberately slow.
 */
export const PANE_PROBE_RECHECK_MS = 5000;

/** An unbroken run of PTY output. */
export interface ActivityStreak {
  /** When this run began. */
  startedAt: number;
  /** The most recent chunk in it. */
  lastAt: number;
}

/**
 * Fold one output chunk into the current streak, starting a new one when the
 * pane has been quiet longer than `gapMs`.
 */
export function trackActivityStreak(
  streak: ActivityStreak | null,
  now: number,
  gapMs: number = ACTIVITY_GAP_MS
): ActivityStreak {
  if (!streak || now - streak.lastAt > gapMs) return { startedAt: now, lastAt: now };
  return { startedAt: streak.startedAt, lastAt: now };
}

/**
 * True once a streak has been running long enough to mean work rather than a
 * single repaint. Measured on the streak's own span (`lastAt - startedAt`), not
 * against the caller's clock, so a stale streak cannot age into a true.
 */
export function isSustainedActivity(streak: ActivityStreak | null, streakMs: number = WORKING_STREAK_MS): boolean {
  return !!streak && streak.lastAt - streak.startedAt >= streakMs;
}

/** True when the pane has produced nothing for long enough to call it idle. */
export function isPaneQuiet(lastActivityAt: number, now: number, silenceMs: number = IDLE_SILENCE_MS): boolean {
  return now - lastActivityAt >= silenceMs;
}

/**
 * How many lines at the foot of a pane capture may hold the background-work chip.
 *
 * Claude Code draws that chip on the last row of the screen, under its composer box
 * and under whatever status line the user configured, so five lines reach it with
 * room to spare. The ceiling is the point of the constant: the transcript above the
 * composer quotes arbitrary text, and a session that PRINTS the words "1 monitor"
 * must not be read as running one.
 */
export const WATCHING_TAIL_LINES = 5;

/**
 * What a pane says is still running in the background, e.g. `1 monitor` or `2 shells`.
 *
 * The CLI writes that chip while a monitor, a backgrounded shell or a cloud session it
 * started is still going, which is exactly the case where the agent has ended its turn
 * without wanting anything from the user. `pattern` comes from the CLI's own registry
 * entry (`capabilities.workDetect.watchingLine`); group 1 is the label when the pattern
 * declares one, and the whole match stands in when it does not.
 *
 * @returns the label, or null when the pane shows no background work
 */
export function watchingLabel(paneText: string | null | undefined, pattern: RegExp): string | null {
  if (!paneText) return null;
  const lines = paneText
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '');
  if (lines.length === 0) return null;
  // A pattern compiled by compileVersionRegex() never carries the `g` flag, but a caller
  // reaching in from a test or a config reload might, and a stale lastIndex would make
  // the same screen match every other call.
  pattern.lastIndex = 0;
  const match = pattern.exec(lines.slice(-WATCHING_TAIL_LINES).join('\n'));
  if (!match) return null;
  const label = (match[1] ?? match[0]).trim();
  return label === '' ? null : label;
}
