/**
 * @fileoverview Static guard: no NEW CLI-id branch in the two files PR B2 touched
 * (`session-ui.js`, `mobile-overview.js`), mirroring
 * `test/cli-registry-no-id-branching.test.ts` for the backend registry.
 *
 * Deliberately scoped to ONLY these two files, not all of `src/web/public/`.
 * `docs/cli-registry.md` and CLAUDE.md are explicit that the rest of the
 * frontend (`app.js`, `terminal-ui.js`, `styles.css`, `settings-ui.js`, …)
 * keeps its own hand-authored per-CLI rules deliberately — "moving them is
 * its own piece of work verified by a browser/mobile suite the CI gate cannot
 * see." Widening this guard to the whole directory would force either fixing
 * or allowlisting dozens of branches in files nobody has touched or reviewed
 * for this change, which is scope B2 never took on.
 *
 * Port: none (pure static analysis).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const PUBLIC = fileURLToPath(new URL('../src/web/public/', import.meta.url));
const SCANNED_FILES = ['session-ui.js', 'mobile-overview.js'];

/**
 * Every currently-surviving branch, each with the reason it is not a
 * CLI-behaviour branch a `CliCapabilities` field should express, keyed
 * `<file>::<the matched expression>` — deliberately NO line number. An
 * earlier version keyed on `<file>::<line>::<expression>`, and inserting one
 * comment line at the top of `session-ui.js` shifted every subsequent line
 * number, so all 21 entries went stale and the same 21 branches were then
 * reported as "new". `session-ui.js` is one of the most contended files in
 * the repo, so a guard that goes red on any unrelated edit to it sends the
 * next person after the wrong problem. Several entries below cover more than
 * one physical call site sharing the same expression in the same file —
 * that collapsing is the point, not a loss of precision (the backend guard
 * this mirrors made the identical choice, for the identical reason).
 */
const ALLOWED_BRANCHES: Record<string, string> = {
  "session-ui.js::mode === 'shell'":
    'run() dispatch: shell needs no CLI probe at all, and it keeps its own row in the ' +
    'button-label ternary (pinned exact text, see Open Question 7 in PR-B2.md)',

  "session-ui.js::mode === 'claude'":
    'four claude-specific call sites, not one branch: run() dispatch (claude has its own ' +
    'remote/docker branching and parallel-create path, unlike every RUN_MODE_LAUNCH entry), ' +
    'runCustomModelEntry() (restart-vs-one-shot launch mechanism, not a preference — see ' +
    "CLAUDE.md's Custom Model Endpoint Profiles section), the Respawn/Ralph section (claude-only " +
    "by design, mirroring the backend capabilities.ralph gate), and the runMode setter's " +
    'validity check',

  // The 8 external CLIs share the same two call sites and the same reason at
  // each: the button-label ternary (pinned exact text — test/run-mode-ui.test.ts
  // asserts e.g. 'Run OMP', which diverges from CliEntry.shortBadge for at
  // least omp ('OM' vs the displayed 'OMP'), so a catalogue-driven rewrite
  // would silently change user-visible text and break that pinned test — see
  // Open Question 7 in PR-B2.md), and the runMode property setter's validity
  // allowlist (not a behaviour branch; left hardcoded in Phase 2 since its
  // chain has no shell arm at all and no evidence of what callers rely on it).
  "session-ui.js::mode === 'opencode'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'codex'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'gemini'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'antigravity'":
    'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'pi'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'grok'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'deepseek'": 'button-label ternary + runMode setter validity check (see the header comment)',
  "session-ui.js::mode === 'omp'": 'button-label ternary + runMode setter validity check (see the header comment)',

  // mobile-overview.js: shell is exempt from the isCliAvailable() gate the
  // same way the toolbar's #runModeMenu exempts it (shell needs no CLI).
  "mobile-overview.js::mode !== 'shell'": 'shell needs no CLI, so it is exempt from the availability gate',
};

/** Every stock CLI id, derived rather than restated so a new entry is covered automatically. */
const IDS = STOCK_CLIS.map((e) => e.id as string);
const ID_ALT = IDS.join('|');

/** Same four shapes as the backend guard — see its own comment for why all four matter. */
const BRANCH_PATTERN = new RegExp(
  [
    `\\b(?:mode|id|agentType)\\s*[!=]==\\s*'(?:${ID_ALT})'`,
    `\\bcase\\s+'(?:${ID_ALT})'\\s*:`,
    `'(?:${ID_ALT})'\\s*(?:,\\s*'(?:${ID_ALT})'\\s*)*\\]\\s*\\.includes\\(`,
  ].join('|'),
  'g'
);

/** Blanks comment lines before scanning — see the backend guard's own comment on why. */
function uncommented(source: string): string {
  return source
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*|\/\*)/.test(line) ? '' : line))
    .join('\n');
}

interface Finding {
  file: string;
  expression: string;
  line: number;
  key: string;
}

function scan(): Finding[] {
  const findings: Finding[] = [];
  for (const file of SCANNED_FILES) {
    const lines = uncommented(readFileSync(PUBLIC + file, 'utf-8')).split('\n');
    lines.forEach((line, i) => {
      BRANCH_PATTERN.lastIndex = 0; // shared /g regex — see utils/regex-patterns.ts
      for (const match of line.matchAll(BRANCH_PATTERN)) {
        const expression = match[0].replace(/\s+/g, ' ').replace(/^(?:id|agentType)/, 'mode');
        findings.push({ file, expression, line: i + 1, key: `${file}::${expression}` });
      }
    });
  }
  return findings;
}

const findings = scan();

describe('no NEW CLI-id branching in session-ui.js / mobile-overview.js (PR B2)', () => {
  it('scans both files (sanity)', () => {
    // If this drops to zero the scanner or the file list drifted and every
    // assertion below would pass vacuously.
    const scannedBytes = SCANNED_FILES.reduce((n, f) => n + readFileSync(PUBLIC + f, 'utf-8').length, 0);
    expect(scannedBytes).toBeGreaterThan(10_000);
  });

  it('builds its id list from the live catalog (sanity)', () => {
    expect(IDS).toContain('claude');
    expect(IDS).toContain('deepseek');
    expect(IDS.length).toBeGreaterThanOrEqual(9);
  });

  it('still detects a branch when one exists (anti-vacuity)', () => {
    const samples = [
      "if (session.mode === 'codex') { doSomething(); }",
      "if (mode !== 'shell' && mode !== 'deepseek') { doSomething(); }",
      "switch (mode) { case 'gemini': return 1; }",
      "if (['codex', 'gemini'].includes(mode)) { doSomething(); }",
    ];
    for (const sample of samples) {
      BRANCH_PATTERN.lastIndex = 0;
      expect(sample.match(BRANCH_PATTERN), `pattern missed: ${sample}`).not.toBeNull();
    }
    BRANCH_PATTERN.lastIndex = 0;
    expect(uncommented("  // mode === 'codex'\ncode();").match(BRANCH_PATTERN)).toBeNull();
  });

  it('has no unapproved id branches', () => {
    const offenders = findings.filter((f) => !(f.key in ALLOWED_BRANCHES));
    const detail = offenders.map((f) => `  ${f.file}:${f.line}  ${f.expression}`).join('\n');
    expect(
      offenders,
      offenders.length === 0
        ? ''
        : `Found ${offenders.length} new CLI-id branch(es) in session-ui.js/mobile-overview.js:\n${detail}\n\n` +
            'Two ways out, in order of preference:\n' +
            '  1. Derive the difference from a shared module-level constant, the way\n' +
            '     _runCliMode()/RUN_MODE_LAUNCH/EXTERNAL_CLI_MODES do.\n' +
            '  2. If it is a genuine mechanism difference (not a CLI-behaviour branch), add it to\n' +
            '     ALLOWED_BRANCHES in this file WITH the reason.'
    ).toEqual([]);
  });

  it('has no stale allowlist entries', () => {
    // An allowlisted branch that no longer exists anywhere in either file is a
    // lie about the codebase, and the next person to reintroduce that exact
    // expression would sail straight through under a pre-approved reason that
    // no longer describes anything real.
    const present = new Set(findings.map((f) => f.key));
    const stale = Object.keys(ALLOWED_BRANCHES).filter((key) => !present.has(key));
    expect(stale, `ALLOWED_BRANCHES entries no longer present — delete them:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
