// Port: none (pure helpers + a real headless xterm + source guards).
//
// Issue #464, "text gets muffled sometimes". The report is a phone screenshot
// where lines of Claude Code's output are rendered twice and short tool
// summaries sit inside longer prose rows with the prose's tail still showing.
//
// That is not a dropped frame or a frozen renderer; it is arithmetic. Ink wraps
// its frame at the width the PTY reported and erases the previous frame by
// walking the cursor up the number of rows it BELIEVES that frame occupied. A
// browser terminal narrower than the PTY makes each logical line occupy more
// physical rows than Ink counted, so `eraseLines(n)` clears too few of them and
// the new frame paints over rows that were never erased.
//
// `renders each wrapped line twice when the PTY is wider` below reproduces it
// against the repo's own xterm, and is written as a CONTRAST: the same stream at
// a matching width must come out clean. An implementation that stopped fixing
// anything would fail the second half, not quietly satisfy the first.
//
// The rest pins the invariant the fix rests on: there is exactly ONE function
// that changes the terminal's size, it applies the same floor it reports, and
// the server reports back the geometry the PTY actually holds so a client whose
// resize was declined can adopt it instead of rendering against a screen that
// does not exist.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';

const { Terminal } = xtermHeadless as unknown as {
  Terminal: new (opts: Record<string, unknown>) => {
    write(data: string, cb?: () => void): void;
    buffer: {
      active: { length: number; getLine(y: number): { translateToString(trim?: boolean): string } | undefined };
    };
  };
};

const read = (rel: string) => readFileSync(resolve(import.meta.dirname, '..', rel), 'utf8');

type Dims = { cols: number; rows: number };

function loadGeometry() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('src/web/public/constants.js'), context, { filename: 'constants.js' });
  return (
    context.window as {
      CodemanTerminalGeometry: {
        clampTerminalDimensions: (p: Partial<Dims> | null | undefined) => Dims | null;
        terminalGeometryAgrees: (a: Dims | null, b: Dims | null) => boolean;
        reconcilePtyGeometry: (local: Dims | null, pty: Partial<Dims> | null) => { adopt: boolean; oversized: boolean };
        TERMINAL_MIN_COLS: number;
        TERMINAL_MIN_ROWS: number;
      };
    }
  ).CodemanTerminalGeometry;
}

// ───────────────────────────────────────────────────────────────────────────
// The failure itself, against the real terminal.
// ───────────────────────────────────────────────────────────────────────────

/** ansi-escapes `eraseLines(n)`: \x1b[2K per row walking up, then column 1. */
function eraseLines(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += '\x1b[2K' + (i < n - 1 ? '\x1b[1A' : '');
  return n ? out + '\x1b[G' : '';
}

/** How many physical rows Ink thinks its frame took, wrapping at `cols`. */
const rowsAt = (frame: string[], cols: number) =>
  frame.reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0);

/**
 * Ink's repaint loop: erase the previous frame, write the new one. The erase
 * count is computed at `ptyCols` — the width the PTY told the CLI about —
 * while the terminal is `xtermCols` wide.
 */
function inkStream(frames: string[][], ptyCols: number): string {
  let out = '';
  let previousRows = 0;
  for (const frame of frames) {
    out += eraseLines(previousRows) + frame.join('\r\n');
    previousRows = rowsAt(frame, ptyCols);
  }
  return out;
}

async function render(data: string, cols: number, rows = 24): Promise<string[]> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 500 });
  await new Promise<void>((done) => term.write(data, () => done()));
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) lines.push(buf.getLine(y)?.translateToString(true) ?? '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

describe('a terminal that disagrees with the PTY about width', () => {
  const XTERM_COLS = 62;
  // Prose long enough to wrap, then a live region that shrinks as tool calls
  // collapse into one-line summaries — ordinary Claude Code output.
  const PROSE = [
    "• Password store entries exist, but GPG can't decrypt — that's the locked keyring after a pod restart. Let me get the browsers sorted.",
  ];
  const FRAMES = [
    [...PROSE, '  Reading settings, scanning the pass store and checking whether the agent can reach AWS'],
    [...PROSE, '  Ran 1 shell command'],
  ];

  it('renders each wrapped line twice when the PTY is wider', async () => {
    const lines = await render(inkStream(FRAMES, 120), XTERM_COLS);
    const duplicated = lines.filter((line, i) => line !== '' && lines.indexOf(line) !== i);
    expect(
      duplicated.length,
      `a 120-column PTY against a ${XTERM_COLS}-column terminal must leave ghost rows:\n${lines.join('\n')}`
    ).toBeGreaterThan(0);
  });

  // The contrast. Without this half, an implementation that fixed nothing —
  // or a stream that never ghosted in the first place — would still pass above.
  it('renders each line exactly once when the two agree', async () => {
    const lines = await render(inkStream(FRAMES, XTERM_COLS), XTERM_COLS);
    const duplicated = lines.filter((line, i) => line !== '' && lines.indexOf(line) !== i);
    expect(duplicated, `matched widths must render cleanly:\n${lines.join('\n')}`).toEqual([]);
    // And the frame that actually won is the last one.
    expect(lines[lines.length - 1]).toBe('  Ran 1 shell command');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The decisions, pure.
// ───────────────────────────────────────────────────────────────────────────

describe('clampTerminalDimensions', () => {
  const { clampTerminalDimensions, TERMINAL_MIN_COLS, TERMINAL_MIN_ROWS } = loadGeometry();

  it('floors a proposal too small to be a usable PTY', () => {
    expect(clampTerminalDimensions({ cols: 12, rows: 4 })).toEqual({
      cols: TERMINAL_MIN_COLS,
      rows: TERMINAL_MIN_ROWS,
    });
  });

  it('leaves a proposal that already clears the floor alone', () => {
    expect(clampTerminalDimensions({ cols: 62, rows: 40 })).toEqual({ cols: 62, rows: 40 });
  });

  it('floors each axis independently — a short phone is not a narrow one', () => {
    // The everyday case behind #464: keyboard up, plenty of columns, under ten rows.
    expect(clampTerminalDimensions({ cols: 62, rows: 6 })).toEqual({ cols: 62, rows: TERMINAL_MIN_ROWS });
  });

  it('reports nothing rather than a guess when the terminal cannot be measured', () => {
    for (const bad of [null, undefined, {}, { cols: NaN, rows: 10 }, { cols: 40, rows: Infinity }]) {
      expect(clampTerminalDimensions(bad as Partial<Dims>)).toBeNull();
    }
  });
});

describe('reconcilePtyGeometry', () => {
  const { reconcilePtyGeometry } = loadGeometry();

  it('does nothing when the terminal already matches the PTY', () => {
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 62, rows: 40 })).toEqual({
      adopt: false,
      oversized: false,
    });
  });

  it('adopts a PTY the client never asked for — a declined resize is still the truth', () => {
    // Session.resize ignores a small viewport while a desktop claim is live.
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 120, rows: 40 })).toEqual({
      adopt: true,
      oversized: true,
    });
  });

  it('adopts without claiming oversized when the PTY is merely shorter or narrower', () => {
    expect(reconcilePtyGeometry({ cols: 120, rows: 40 }, { cols: 80, rows: 40 })).toEqual({
      adopt: true,
      oversized: false,
    });
    expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, { cols: 62, rows: 12 })).toEqual({
      adopt: true,
      oversized: false,
    });
  });

  it('keeps its own geometry when the server reported none', () => {
    // An older server answers the resize POST with `{}`; that is not evidence.
    for (const bad of [null, {}, { cols: 62 }, { cols: 'wide', rows: 40 }]) {
      expect(reconcilePtyGeometry({ cols: 62, rows: 40 }, bad as Partial<Dims>)).toEqual({
        adopt: false,
        oversized: false,
      });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// One owner of the terminal's size. These are source guards because the code
// they cover needs a real DOM (FitAddon measures a rendered element), which
// the CI gate has no way to give it.
// ───────────────────────────────────────────────────────────────────────────

describe('exactly one function may change the terminal size', () => {
  const terminalUi = read('src/web/public/terminal-ui.js');
  const mobileHandlers = read('src/web/public/mobile-handlers.js');

  function bodyOf(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} not found — renamed?`).toBeGreaterThan(-1);
    const end = source.indexOf('\n  },', start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('syncTerminalGeometry applies the floor it reports, not the raw proposal', () => {
    const body = bodyOf(terminalUi, 'syncTerminalGeometry() {');
    expect(body).toContain('this.fitAddon.fit()');
    // fit() resizes to proposeDimensions() RAW; the floored value is what goes
    // to the server, so the floored value is what xterm must end up holding.
    expect(body).toContain('this.getTerminalDimensions()');
    expect(body).toContain('this._resizeTerminalTo(dims)');
  });

  // A whole-repo sweep rather than a spot check, so a NEW call site trips it
  // rather than quietly reopening #464. Scoped to the MAIN terminal: the split
  // pane, the teammate windows and the log viewer are separate xterm instances
  // with their own PTYs (or none), and each owns its own sizing.
  it('no other call site fits the main terminal behind its back', () => {
    const MAIN_TERMINAL_FIT = /^(?!.*(?:_splitPane|entry\.fitAddon)).*fitAddon[?.]*\.fit\(\)/;
    const offenders: string[] = [];
    for (const rel of [
      'src/web/public/terminal-ui.js',
      'src/web/public/mobile-handlers.js',
      'src/web/public/app.js',
      'src/web/public/ralph-panel.js',
      'src/web/public/settings-ui.js',
      'src/web/public/tab-rail-resize.js',
      'src/web/public/notification-manager.js',
    ]) {
      read(rel)
        .split('\n')
        .forEach((line, i) => {
          const code = line.trim();
          if (code.startsWith('*') || code.startsWith('//')) return; // prose about fit(), not a call
          if (MAIN_TERMINAL_FIT.test(line)) offenders.push(`${rel}:${i + 1} ${code}`);
        });
    }
    // Exactly one: the owner's own fit.
    expect(
      offenders,
      'every fit of the main terminal must go through syncTerminalGeometry(), which applies ' +
        'the same floor it reports — a bare fit() leaves xterm at the RAW proposal while the ' +
        'server is told the floored one (issue #464)'
    ).toHaveLength(1);
    expect(offenders[0]).toContain('terminal-ui.js');
    expect(bodyOf(terminalUi, 'syncTerminalGeometry() {')).toContain('this.fitAddon.fit()');
    expect(mobileHandlers).toContain('app.syncTerminalGeometry?.()');
  });

  it('a font change tells the server, because it moves the cell size', () => {
    // Bigger glyphs mean fewer columns in the same box. These three refitted
    // and sent nothing, so the CLI kept wrapping at the old column count.
    for (const setter of [
      'setFontSize(size) {',
      'this.terminal.options.fontFamily === resolved',
      'this.terminal.options.fontWeight === fontWeight',
    ]) {
      expect(terminalUi, `${setter} no longer present`).toContain(setter);
    }
    expect(bodyOf(terminalUi, 'setFontSize(size) {')).toContain('this._refitAfterCellSizeChange()');
    const helper = bodyOf(terminalUi, '_refitAfterCellSizeChange() {');
    expect(helper).toContain('this.sendResize(this.activeSessionId)');
    expect(helper).toContain('this.syncTerminalGeometry()');
    // Three call sites in the font setters (size, family, weight) plus the two
    // font-settle re-fits.
    expect((terminalUi.match(/_refitAfterCellSizeChange\(\)/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('the keyboard one-shot delegates rather than computing its own numbers', () => {
    const body = bodyOf(mobileHandlers, '_sendTerminalResize() {');
    expect(body).toContain('app.sendResize');
    // The hand-rolled POST floored what it sent and nothing else.
    expect(body).not.toContain('proposeDimensions');
    expect(body).not.toContain('Math.max');
    expect(body).not.toContain('fetch(');
  });

  it('sendResize yields a detached session BEFORE touching geometry, not after', () => {
    const body = bodyOf(terminalUi, 'async sendResize(sessionId, options = {}) {');
    const yieldAt = body.indexOf('detachedSessions?.has(sessionId)) return false');
    const fitAt = body.indexOf('this.syncTerminalGeometry()');
    expect(yieldAt, 'the detached-session yield is gone').toBeGreaterThan(-1);
    expect(fitAt, 'sendResize no longer syncs geometry').toBeGreaterThan(-1);
    expect(
      yieldAt,
      'withholding the server resize but reflowing anyway leaves this xterm at a shape ' +
        'the PTY was never told about — withhold both or neither'
    ).toBeLessThan(fitAt);
  });

  it('throttledResize withholds the fit wherever it withholds the SIGWINCH', () => {
    const start = terminalUi.indexOf('const throttledResize = () => {');
    expect(start).toBeGreaterThan(-1);
    const block = terminalUi.slice(start, terminalUi.indexOf("window.addEventListener('resize', throttledResize)"));
    const guardAt = block.indexOf('!keyboardUp && !detachedElsewhere');
    const syncAt = block.indexOf('this.syncTerminalGeometry()');
    expect(guardAt).toBeGreaterThan(-1);
    expect(syncAt, 'the geometry sync must sit INSIDE the guard').toBeGreaterThan(guardAt);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Resize stopped being write-only.
// ───────────────────────────────────────────────────────────────────────────

describe('the server reports the geometry the PTY actually holds', () => {
  it('Session exposes the effective dimensions', () => {
    const session = read('src/session.ts');
    expect(session).toMatch(/get ptyCols\(\): number \{\s*return this\._ptyCols;/);
    expect(session).toMatch(/get ptyRows\(\): number \{\s*return this\._ptyRows;/);
  });

  it('the WebSocket answers a resize with what took', () => {
    const ws = read('src/web/routes/ws-routes.ts');
    const at = ws.indexOf('session.resize(msg.c, msg.r,');
    expect(at).toBeGreaterThan(-1);
    const after = ws.slice(at, at + 1400);
    expect(after).toContain('"t":"zc"');
    expect(after).toContain('session.ptyCols');
    expect(after).toContain('session.ptyRows');
    // Documented in the protocol block at the top of the file, like every other frame.
    expect(ws).toContain('{"t":"zc","c":N,"r":N}');
  });

  it('the HTTP resize answers with what took, not an empty object', () => {
    const routes = read('src/web/routes/session-routes.ts');
    const at = routes.indexOf("app.post('/api/sessions/:id/resize'");
    expect(at).toBeGreaterThan(-1);
    const handler = routes.slice(at, at + 1600);
    expect(handler).toContain('return { cols: session.ptyCols, rows: session.ptyRows };');
  });

  it('the client adopts the report and re-bases its dedupe on it', () => {
    const terminalUi = read('src/web/public/terminal-ui.js');
    const start = terminalUi.indexOf('_onPtyGeometryReport(sessionId, cols, rows) {');
    expect(start).toBeGreaterThan(-1);
    const body = terminalUi.slice(start, terminalUi.indexOf('\n  },', start));
    expect(body).toContain('reconcilePtyGeometry');
    expect(body).toContain('this._resizeTerminalTo({ cols, rows })');
    // Without this the next resize is deduped against a request that was
    // REFUSED, which suppresses the retry that recovers the pane.
    expect(body).toContain('this._lastResizeDims = { cols, rows }');
    // And the WS frame is wired up at all.
    expect(read('src/web/public/app.js')).toContain("msg.t === 'zc'");
  });

  it('a pane wider than the screen gets horizontal reach for as long as that lasts', () => {
    const css = read('src/web/public/styles.css');
    // .terminal-container is overflow:hidden, so adopting a wider PTY without
    // this puts the right-hand columns somewhere no gesture can reach them.
    // Read the rule's DECLARATIONS, comments stripped: the comments in this block
    // quote CSS with braces in it, which a `[^}]*` window cannot survive.
    const declarationsOf = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, `${selector} not found`).toBeGreaterThan(-1);
      const body = css.slice(at + selector.length, css.indexOf('\n}', at));
      return body.replace(/\/\*[\s\S]*?\*\//g, '');
    };
    const oversized = declarationsOf('.terminal-container.pty-oversized');
    expect(oversized).toContain('overflow-x: auto;');
    // Both axes, explicitly: mobile.css sets `overflow: visible` on the bare
    // selector, and a lone overflow-x would leave overflow-y computing to auto.
    expect(oversized).toContain('overflow-y: hidden;');
    // On the base rule, not only the .touch-device variant — mobile.css's
    // `.terminal-container { touch-action: none }` is unscoped.
    expect(oversized).toContain('touch-action: pan-x;');
    // The class is only ever on while the mismatch is.
    expect(read('src/web/public/terminal-ui.js')).toContain("classList.toggle('pty-oversized', !!oversized)");
  });
});
