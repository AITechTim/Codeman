/**
 * What a copy actually puts on the clipboard.
 *
 * xterm returns whole screen rows and trims only the cells that were never
 * written to, so a full-screen TUI's padding spaces reach the clipboard and the
 * indent it repeats on every row arrives baked into every line. These tests
 * drive the SHIPPED transform (`CodemanCopySelection.clean` in constants.js),
 * the SHIPPED wiring that decides column mode and the mid-row flag, and both
 * SHIPPED copy paths, because the interesting failures live in the paths rather
 * than in the string handling: a padding-only selection must not silently keep
 * the user's Ctrl+C, and must not put a bare newline on the clipboard.
 *
 * Strategy: constants.js and terminal-ui.js in one vm with a stub CodemanApp,
 * the harness shape test/terminal-auto-copy.test.ts uses. No DOM, no xterm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

function loadHarness() {
  const CodemanApp = function CodemanApp(this: unknown) {};
  const windowRef: Record<string, any> = {};
  const context = vm.createContext({
    window: windowRef,
    document: {
      body: { classList: { contains: () => false } },
      getElementById: () => null,
      querySelector: () => null,
      addEventListener: () => {},
    },
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    requestAnimationFrame: () => 1,
    setTimeout: () => 1,
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false, getDeviceType: () => 'desktop' },
    KeyboardHandler: { keyboardVisible: false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });

  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as unknown as new () => Record<string, any>)();
  const toasts: { message: string; type: string }[] = [];
  app.showToast = (message: string, type: string) => toasts.push({ message, type });
  app._copyText = vi.fn(async () => true);
  app.loadAppSettingsFromStorage = () => ({ autoCopySelection: true });

  const setSelection = (selection: string, { startX = 0, columnMode = false } = {}) => {
    app.terminal = {
      hasSelection: () => !!selection,
      getSelection: vi.fn(() => selection),
      getSelectionPosition: () => ({ start: { x: startX, y: 0 }, end: { x: 0, y: 1 } }),
      clearSelection: vi.fn(),
      focus: vi.fn(),
      _core: { _selectionService: { _activeSelectionMode: columnMode ? 3 : 0 } },
    };
    return app.terminal;
  };

  return { app, windowRef, toasts, setSelection };
}

const clean = (text: unknown, startedMidRow = false) =>
  loadHarness().windowRef.CodemanCopySelection.clean(text, { startedMidRow });

describe('CodemanCopySelection.clean — trailing padding', () => {
  it('drops the padding a full-screen TUI writes across the rest of each row', () => {
    expect(clean('hello     \nworld       ')).toBe('hello\nworld');
  });

  it('drops it from a single-row selection too', () => {
    expect(clean('hello     ')).toBe('hello');
  });

  it('keeps the line endings xterm chose, including the Windows \\r\\n', () => {
    expect(clean('hello   \r\nworld  \r\n')).toBe('hello\r\nworld\r\n');
  });

  it('drops trailing tabs as well as trailing spaces', () => {
    expect(clean('hello \t \nworld')).toBe('hello\nworld');
  });

  it('leaves a line that has no padding untouched', () => {
    expect(clean('hello\nworld')).toBe('hello\nworld');
  });
});

describe('CodemanCopySelection.clean — shared leading indent', () => {
  it('removes the indent every selected row shares', () => {
    expect(clean('  first line\n  second line')).toBe('first line\nsecond line');
  });

  it('keeps the relative indentation of anything nested inside the block', () => {
    expect(clean('  outer\n    inner\n  outer again')).toBe('outer\n  inner\nouter again');
  });

  it('is a no-op when the rows share no indent, as shell output does not', () => {
    expect(clean('$ ls\n  indented output\ndone')).toBe('$ ls\n  indented output\ndone');
  });

  it('is not disabled by a blank row in the middle of the block', () => {
    expect(clean('  first  \n   \n  second  ')).toBe('first\n\nsecond');
  });

  it('does not eat a \\r when the row is blank and the shared indent is wider', () => {
    expect(clean('    first\r\n\r\n    second\r\n')).toBe('first\r\n\r\nsecond\r\n');
  });

  it('treats a leading tab as no indent at all, so nothing is stripped', () => {
    expect(clean('\tfirst\n  second')).toBe('\tfirst\n  second');
  });
});

describe('CodemanCopySelection.clean — one row keeps its own indent', () => {
  // A single row shares its leading run with nothing, so that run is content.
  // Stripping it would silently reindent one line of `git log` body text or one
  // line read out of `less`.
  it('leaves the indent on a single-row selection', () => {
    expect(clean('    hello world   ')).toBe('    hello world');
  });

  it('leaves it on a single row followed by a blank row', () => {
    expect(clean('    hello world\n   ')).toBe('    hello world\n');
  });

  it('strips as soon as a second row carries content', () => {
    expect(clean('    hello\n    world')).toBe('hello\nworld');
  });
});

describe('CodemanCopySelection.clean — a drag that began inside a row', () => {
  it('measures the shared indent without the partial first line', () => {
    expect(clean('That sample is clean.\n  the next row continues.', true)).toBe(
      'That sample is clean.\nthe next row continues.'
    );
  });

  it('leaves the partial first line exactly as it is, indent included', () => {
    expect(clean('  already mid-row\n    following row\n      deeper row', true)).toBe(
      '  already mid-row\nfollowing row\n  deeper row'
    );
  });
});

describe('CodemanCopySelection.clean — nothing to clean', () => {
  it('returns an empty string for an empty selection', () => {
    expect(clean('')).toBe('');
  });

  it('returns an empty string rather than throwing on a non-string', () => {
    expect(clean(undefined)).toBe('');
    expect(clean(null)).toBe('');
  });

  it('reduces an all-padding selection to its line breaks alone', () => {
    // The copy paths reject this with trim(); the transform itself only removes
    // whitespace, so the row structure survives here by design.
    expect(clean('    \n      \n  ')).toBe('\n\n');
  });
});

describe('cleanedTerminalSelection — wiring', () => {
  it('strips the shared indent when the drag began at column 0', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first\n  second');
    expect(app.cleanedTerminalSelection()).toBe('first\nsecond');
  });

  it('spares the first line when the drag began inside a row', () => {
    const { app, setSelection } = loadHarness();
    setSelection('first\n  second', { startX: 6 });
    expect(app.cleanedTerminalSelection()).toBe('first\nsecond');
  });

  it('uses the text it is given without reading the selection again', () => {
    const { app, setSelection } = loadHarness();
    // The contract is that `text` IS the live selection, so the stub agrees with
    // it; the assertion that carries weight is that getSelection went unread.
    const terminal = setSelection('  given text  \n  second row  ');
    expect(app.cleanedTerminalSelection('  given text  \n  second row  ')).toBe('given text\nsecond row');
    expect(terminal.getSelection).not.toHaveBeenCalled();
  });

  it('returns an empty string when there is no selection at all', () => {
    const { app, setSelection } = loadHarness();
    setSelection('');
    expect(app.cleanedTerminalSelection()).toBe('');
  });

  it('leaves a column selection completely untouched', () => {
    // Alt+drag makes a rectangle, and its rows lining up is the whole point:
    // both halves of the clean would destroy that alignment.
    const { app, setSelection } = loadHarness();
    const rect = '  alpha   \n  beta    \n  gamma   ';
    setSelection(rect, { startX: 40, columnMode: true });
    expect(app.cleanedTerminalSelection()).toBe(rect);
  });
});

describe('the xterm internals the column check depends on', () => {
  // The column check reads a private field and compares it to a literal, because
  // xterm publishes the selection mode nowhere. A rename or a renumber would make
  // every rectangular selection get cleaned with both rules and lose the column
  // alignment the rule exists to protect, and the fallback is silent by design.
  // So the assumption is pinned against the real library rather than only against
  // a stub that repeats it. lib/xterm.js is the esbuild input for the shipped
  // vendor bundle, so it is the file that decides what runs in the browser.
  const xtermLib = readFileSync(resolve(import.meta.dirname, '../node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');

  it('still branches on _activeSelectionMode === 3 for a column selection', () => {
    expect(xtermLib).toContain('3===this._activeSelectionMode');
  });

  it('still reaches that field through _selectionService', () => {
    expect(xtermLib).toContain('_selectionService');
  });
});

describe('copyTerminalSelection — what reaches the clipboard', () => {
  it('copies the cleaned text, never the padded rows', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first line      \n  second line     ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(true);
      expect(app._copyText).toHaveBeenCalledWith('first line\nsecond line');
    });
  });

  it('cleans a realistic TUI block on both rules at once', () => {
    const { app, setSelection } = loadHarness();
    const pane = ['  That last point is the important one.   ', '  Claude Code writes each paragraph.      '].join(
      '\n'
    );
    setSelection(pane);
    return app.copyTerminalSelection().then(() => {
      expect(app._copyText).toHaveBeenCalledWith(
        'That last point is the important one.\nClaude Code writes each paragraph.'
      );
    });
  });

  it('clears a padding-only selection so Ctrl+C goes back to interrupting', () => {
    // The Ctrl+C gate tests the RAW selection. Leaving a padding-only selection
    // set would make every later Ctrl+C copy nothing instead of interrupting.
    const { app, toasts, setSelection } = loadHarness();
    const terminal = setSelection('                 ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(false);
      expect(app._copyText).not.toHaveBeenCalled();
      expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
      expect(toasts).toEqual([{ message: 'Nothing to copy', type: 'warning' }]);
    });
  });

  it('rejects a multi-row padding selection instead of copying bare newlines', () => {
    const { app, setSelection } = loadHarness();
    const terminal = setSelection('      \n        \n   ');
    return app.copyTerminalSelection().then((ok: boolean) => {
      expect(ok).toBe(false);
      expect(app._copyText).not.toHaveBeenCalled();
      expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
    });
  });
});

describe('_flushAutoCopySelection — cleaned text is what Auto Copy handles', () => {
  it('copies the cleaned text and remembers it for the dedupe', () => {
    const { app, setSelection } = loadHarness();
    setSelection('  first line      \n  second line     ');
    app._autoCopyPending = true;
    return app._flushAutoCopySelection().then(() => {
      expect(app._copyText).toHaveBeenCalledWith('first line\nsecond line');
      expect(app._autoCopyLastText).toBe('first line\nsecond line');
    });
  });

  it('reads nothing at all while the toggle is off', () => {
    // Auto Copy defaults to OFF, and a selection can run to the scrollback
    // ceiling, so the flush must not read or clean before it checks.
    const { app, setSelection } = loadHarness();
    const terminal = setSelection('  first line      \n  second line     ');
    terminal.getSelection = vi.fn(() => '  first line      ');
    app.loadAppSettingsFromStorage = () => ({ autoCopySelection: false });
    app._autoCopyPending = true;
    return app._flushAutoCopySelection().then(() => {
      expect(terminal.getSelection).not.toHaveBeenCalled();
      expect(app._copyText).not.toHaveBeenCalled();
    });
  });
});
