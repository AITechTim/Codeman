// src/web/public/terminal-split.js

/**
 * @fileoverview SplitTerminalPane — a second, independent live terminal pane
 * ("Pane B") for split-view sessions. Deliberately plainer than the primary
 * pane (this.terminal/this._ws in terminal-ui.js): no local-echo overlay, no
 * CJK IME, no touch/mobile handlers, no keyboard accessory bar. Desktop-only
 * feature by nature — see docs/split-pane-sessions-plan.md.
 *
 * @dependency vendor/xterm.js, vendor/xterm-addon-fit.js
 * @dependency constants.js (window.CodemanTerminalFont, DEFAULT_SCROLLBACK, TERMINAL_TAIL_SIZE, TERMINAL_CHUNK_SIZE)
 * @dependency terminal-ui.js (codemanCurrentXtermTheme, codemanCurrentSkinIsLight)
 * @loadorder 7.5 of 16 — loaded after terminal-ui.js, before respawn-ui.js
 */

(function (global) {
  /**
   * Minimal chunked write for Pane B's own xterm instance — write() in
   * TERMINAL_CHUNK_SIZE slices, yielding a frame between each, instead of one
   * giant synchronous write that blocks the main thread while parsing a long
   * scrollback. Deliberately NOT the primary pane's chunkedTerminalWrite
   * (terminal-ui.js): that one is wired into session-switch generation
   * counters and the live-output gate this simpler, independently
   * created/destroyed pane has no equivalent of.
   */
  function writeChunked(terminal, buffer, isDestroyed) {
    if (!buffer) return;
    if (buffer.length <= TERMINAL_CHUNK_SIZE) {
      terminal.write(buffer);
      return;
    }
    let offset = 0;
    const writeNext = () => {
      if (isDestroyed() || !terminal) return;
      const chunk = buffer.slice(offset, offset + TERMINAL_CHUNK_SIZE);
      offset += chunk.length;
      terminal.write(chunk);
      if (offset < buffer.length) {
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(writeNext);
        else setTimeout(writeNext, 16);
      }
    };
    writeNext();
  }

  class SplitTerminalPane {
    constructor(sessionId, mountEl, opts = {}) {
      this.sessionId = sessionId;
      this.mountEl = mountEl;
      this.sessionMode = opts.mode;
      this.fontSettings = opts.fontSettings || {};
      // Live reference (not a snapshot) to the app's detachedSessions Set —
      // detaching this session AFTER the split is already open must still be
      // seen by _sendResize() below, or it re-creates the exact PTY-size
      // fight the split picker already refuses to open at pick time.
      this.detachedSessions = opts.detachedSessions;
      this.terminal = null;
      this.fitAddon = null;
      this.ws = null;
      this._wsReady = false;
      this._destroyed = false;
    }

    async connect() {
      const savedFontSize = parseInt(localStorage.getItem('codeman-font-size'), 10);
      this.terminal = new Terminal({
        theme: { ...global.codemanCurrentXtermTheme() },
        fontFamily: global.CodemanTerminalFont.resolve(this.fontSettings.terminalFontFamily),
        ...global.CodemanTerminalFont.resolveWeights(this.fontSettings),
        fontSize: Number.isFinite(savedFontSize) ? savedFontSize : 14,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'block',
        minimumContrastRatio: global.codemanCurrentSkinIsLight() ? 4.5 : 1,
        scrollback: DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      this.fitAddon = new FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      this.terminal.open(this.mountEl);
      this.fitAddon.fit();

      this.terminal.onData((data) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ t: 'i', d: data }));
        }
      });

      // Load existing scrollback before going live. The WS below is
      // subscribe-only (ws-routes.ts sends nothing on connect, only future
      // 'terminal' events), so without this Pane B stays blank until the
      // target session happens to produce new output. It LOOKED
      // intermittent rather than always-broken because _sendResize() below
      // often nudges the shared session's real tmux window to a new size,
      // and tmux repaints its current screen on resize — that repaint was
      // getting captured and streamed here, incidentally populating the
      // pane. When Pane B's computed dimensions happened to already match
      // the session's last-known size, Session.resize() (session.ts) skips
      // the resize as a no-op, no repaint fires, and the pane stayed blank.
      //
      // Mirrors the primary pane's own mode check (app.js's selectSession):
      // a shell session can retain hundreds of thousands of plain scrollback
      // lines, so pulling `?full=1` there parses an unbounded, server-capped
      // (up to terminalBufferMaxBytes, 32MB) body into a 50000-line xterm on
      // every split. Non-shell (TUI) sessions still get one full replay.
      try {
        const query = this.sessionMode === 'shell' ? `tail=${TERMINAL_TAIL_SIZE}` : 'full=1';
        const res = await fetch(`${window.CodemanBase.base}/api/sessions/${this.sessionId}/terminal?${query}`);
        const payload = (await res.json())?.data ?? {};
        if (payload.terminalBuffer && this.terminal) {
          writeChunked(this.terminal, payload.terminalBuffer, () => this._destroyed);
        }
      } catch {
        /* Best-effort — live output still arrives once the socket below connects. */
      }
      if (this._destroyed) return;

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}${window.CodemanBase.base}/ws/sessions/${this.sessionId}/terminal`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this._wsReady = true;
        this._sendResize();
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.t === 'o') {
            this.terminal.write(msg.d);
          } else if (msg.t === 'c') {
            this.terminal.clear();
          }
        } catch {
          /* Malformed frame — ignore, matches primary pane's tolerance. */
        }
      };

      // Mirror app.js's onclose/onerror pattern (app.js:2905-2964): _wsReady
      // must go false on a drop or fit()/_sendResize() silently no-ops on a
      // closed socket per the WebSocket spec (no exception, no log). No
      // reconnect logic here — Pane B is deliberately plainer than the
      // primary pane (see the fileoverview above); a drop just stops
      // resizing until the parent recreates the pane. But onData already
      // silently drops keystrokes while _wsReady is false (below), so
      // without a visible marker a dropped socket left Pane B looking
      // normal while it quietly ate everything typed into it. v1 scope is
      // "say so", not reconnect — collapsing the split would lose the
      // user's place in Pane B's scrollback for a transient blip.
      this.ws.onclose = () => {
        this._wsReady = false;
        this.terminal?.write('\r\n\x1b[2m[Pane B disconnected — close and reopen the split to reconnect]\x1b[0m\r\n');
      };

      this.ws.onerror = () => {
        // onclose fires after onerror — cleanup happens there.
      };
    }

    // Local reflow only — no PTY resize frame. Split out so a divider drag
    // can reflow both panes at the browser's paint rate (rAF) while sending
    // the actual `{t:'z'}` resize once, at drag end, matching the primary
    // pane's own convention (throttledResize in terminal-ui.js).
    localFit() {
      if (!this.fitAddon) return;
      this.fitAddon.fit();
    }

    fit() {
      this.localFit();
      this._sendResize();
    }

    _sendResize() {
      if (!this._wsReady || !this.fitAddon) return;
      // One PTY cannot hold two sizes (mirrors sendResize's own
      // detachedElsewhere yield in terminal-ui.js): the session got detached
      // to its own window AFTER this split was opened, so its own window now
      // owns the PTY's size and Pane B must stand aside.
      if (this.detachedSessions?.has(this.sessionId)) return;
      const dims = this.fitAddon.proposeDimensions();
      if (!dims) return;
      // Send the real proposed dimensions unclamped, matching the primary
      // pane's convention (terminal-ui.js's getTerminalDimensions()) — the
      // server enforces its own valid range ([1,500]/[1,200] in ws-routes.ts).
      // A 40/10 floor here misreported Pane B's real width to the PTY at the
      // divider's own reachable 20% floor position, causing real
      // output-wrapping bugs.
      this.ws.send(JSON.stringify({ t: 'z', c: dims.cols, r: dims.rows, v: 'desktop' }));
    }

    destroy() {
      this._destroyed = true;
      if (this.ws) {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.close();
        this.ws = null;
      }
      if (this.terminal) {
        this.terminal.dispose();
        this.terminal = null;
      }
      this.fitAddon = null;
    }
  }

  global.SplitTerminalPane = SplitTerminalPane;
})(window);

Object.assign(CodemanApp.prototype, {
  /**
   * Desktop-only gate, same shape as home-sessions.js's shouldShowHomeSessions
   * + matchMedia backstop: a JS width check (so openSplitPane() below can
   * refuse even if a click somehow reaches the button) plus a live listener,
   * because a window narrowed WHILE the button is showing must hide it
   * without waiting for a settings save or reload. The CSS `@media
   * (max-width: 1179px)` rule in styles.css is the backstop for the reverse
   * direction: it hides the button even if this JS never runs at all.
   */
  _applySplitButtonVisibility(enabled) {
    this._splitButtonSettingEnabled = enabled;
    const splitBtn = document.querySelector('.btn-split');
    if (!splitBtn) return;
    const wide = window.innerWidth >= SPLIT_PANE_MIN_WIDTH;
    splitBtn.classList.toggle('btn-split--hidden', !enabled || !wide);
    if (!this._splitButtonWidthListenerInstalled && window.matchMedia) {
      this._splitButtonWidthListenerInstalled = true;
      const mq = window.matchMedia(`(min-width: ${SPLIT_PANE_MIN_WIDTH}px)`);
      mq.addEventListener('change', () => this._applySplitButtonVisibility(this._splitButtonSettingEnabled));
    }
  },

  openSplitPicker(event) {
    // Mirrors toggleRunModeMenu (session-ui.js): stopPropagation on the
    // OPENING click so it never reaches the outside-click listener this
    // same call is about to register — without it, a click landing on the
    // button's own inner <svg> (matched by neither `menu.contains()` nor
    // the old exact-node check below) bubbled straight through to
    // `document` and self-closed the menu it just opened.
    event?.stopPropagation();
    if (this._splitPane) {
      this.closeSplitPane();
      return;
    }
    const candidates = window.CodemanSplitPane.buildSplitPickerSessions(
      this.sessions,
      this.sessionOrder,
      this.activeSessionId,
      this.detachedSessions
    );
    // Route a pre-existing menu through the SAME dismiss path used
    // everywhere else, instead of a raw `.remove()`: a genuinely still-open
    // menu has live document listeners (see below), and a raw removal left
    // them attached forever — only the single-slot field below got
    // overwritten, so every prior pair but the last was orphaned on
    // `document` with no way to ever find and remove it again.
    this._dismissSplitPicker();

    const menu = document.createElement('div');
    menu.id = 'splitPickerMenu';
    menu.className = 'split-picker-menu';
    if (candidates.length === 0) {
      menu.innerHTML = '<div class="split-picker-empty">No other sessions to split with</div>';
    } else {
      menu.innerHTML = candidates
        .map(
          (c) =>
            // data-i18n-skip: the whole row's text IS a session name — i18n.js
            // does exact-string lookup over text nodes, and a session
            // literally named e.g. "Sessions" would otherwise get translated
            // on zh-CN (see the .session-name skip on the pane header below).
            `<div class="split-picker-item" data-i18n-skip data-session-id="${escapeHtml(c.id)}" onclick="app.openSplitPane(${escapeHtml(JSON.stringify(c.id))}); app._dismissSplitPicker();">${escapeHtml(c.label)}</div>`
        )
        .join('');
    }
    document.body.appendChild(menu);
    const splitBtn = document.querySelector('.btn-split');
    if (splitBtn) {
      const rect = splitBtn.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${rect.bottom + 4}px`;
      menu.style.right = `${window.innerWidth - rect.right}px`;
    }

    // Dismiss on outside click or Escape — same one-shot listener pattern as
    // session-ui.js's other transient popovers (toggleCaseSettings(),
    // toggleRunModeMenu()). Deferred by a tick so the click that OPENED the
    // menu (still bubbling) doesn't immediately close it — reinforced by
    // the button's own stopPropagation() above, which is what actually
    // stops that same click reaching `document` at all. Picking an item
    // (above) calls the SAME dismiss method, so these listeners never
    // outlive the menu either way.
    //
    // Self-removing by identity: each handler removes ITSELF (and its
    // sibling) the moment it fires, rather than leaning solely on the
    // `this._splitPickerDismissHandlers` field. That field is still kept in
    // sync (so `_dismissSplitPicker()` called from elsewhere — the picker
    // item's onclick above, or a still-open menu at the top of this method
    // — can find and remove the CURRENT pair), but no path here can ever
    // again leave a pair attached to `document` with nothing referencing it.
    const closeOnOutsideClick = (e) => {
      if (menu.contains(e.target) || e.target.closest('.btn-split')) return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    const closeOnEscape = (e) => {
      if (e.key !== 'Escape') return;
      document.removeEventListener('click', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
      this._splitPickerDismissHandlers = null;
      menu.remove();
    };
    this._splitPickerDismissHandlers = { closeOnOutsideClick, closeOnEscape };
    setTimeout(() => document.addEventListener('click', closeOnOutsideClick), 0);
    document.addEventListener('keydown', closeOnEscape);
  },

  _dismissSplitPicker() {
    document.getElementById('splitPickerMenu')?.remove();
    if (this._splitPickerDismissHandlers) {
      document.removeEventListener('click', this._splitPickerDismissHandlers.closeOnOutsideClick);
      document.removeEventListener('keydown', this._splitPickerDismissHandlers.closeOnEscape);
      this._splitPickerDismissHandlers = null;
    }
  },

  openSplitPane(sessionId) {
    // Desktop-only hard gate, independent of the button's own hidden state —
    // see _applySplitButtonVisibility's comment for why both a JS check and
    // a CSS backstop exist.
    if (window.innerWidth < SPLIT_PANE_MIN_WIDTH) return;
    // No active session means there is no `.terminal-wrap` to split against
    // (the welcome overlay is showing) — without this, a split opened from
    // the home screen still created the container and connected Pane B, just
    // behind the opaque overlay with nothing visible to show for it.
    if (!this.activeSessionId) return;
    // A stale picker click (opened before switching tabs) or clicking Pane
    // B's own session tab while split can otherwise land here with
    // sessionId === activeSessionId: two live WebSockets to the same
    // session, each independently claiming PTY dimensions via its own `{t:'z',...}`
    // resize frame. Refuse before creating any DOM or SplitTerminalPane.
    if (sessionId === this.activeSessionId) return;
    if (this._splitPane) this.closeSplitPane();

    const wrap = document.querySelector('.terminal-wrap');
    const parent = wrap.parentElement;

    const container = document.createElement('div');
    container.className = 'terminal-split-container';

    const divider = document.createElement('div');
    divider.className = 'split-divider';

    const paneB = document.createElement('div');
    paneB.className = 'terminal-pane-b';
    const session = this.sessions.get(sessionId);
    paneB.innerHTML = `
      <div class="terminal-pane-b-header">
        <span class="session-name">${escapeHtml(session?.name || 'Session')}</span>
        <span class="terminal-pane-b-close" onclick="app.closeSplitPane()">&times;</span>
      </div>
      <div class="terminal-pane-b-container"></div>
    `;

    parent.insertBefore(container, wrap);
    container.appendChild(wrap);
    wrap.style.flexBasis = '50%';
    container.appendChild(divider);
    container.appendChild(paneB);
    paneB.style.flexBasis = '50%';

    this._splitPane = new window.SplitTerminalPane(sessionId, paneB.querySelector('.terminal-pane-b-container'), {
      mode: session?.mode,
      fontSettings: this.loadAppSettingsFromStorage?.() || {},
      detachedSessions: this.detachedSessions,
    });
    this._splitPane.connect().catch(() => {
      /* Best-effort, matching the primary pane's own tolerance for a failed
         initial load — live output still arrives once/if the socket connects. */
    });
    this._splitSessionId = sessionId;

    // Pane A just went from full width to 50%, but nothing has told its
    // session's PTY/tmux window about it yet — the passive ResizeObserver in
    // terminal-ui.js debounces 300ms and would eventually catch up, but
    // relying on that left the pane showing stale-width content (existing
    // box-drawing lines, banners) until the user hit "Redraw Terminal".
    // Force it immediately, mirroring closeSplitPane()'s symmetric call.
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});

    this._installSplitDividerDrag(divider, wrap, paneB);
    this._updateSplitButtonState(true);
  },

  closeSplitPane() {
    if (!this._splitPane) return;
    this._splitPane.destroy();
    this._splitPane = null;
    this._splitSessionId = null;
    this._updateSplitButtonState(false);

    const container = document.querySelector('.terminal-split-container');
    if (!container) return;
    const wrap = container.querySelector('.terminal-wrap');
    const parent = container.parentElement;
    wrap.style.flexBasis = '';
    parent.insertBefore(wrap, container);
    container.remove();

    if (this.fitAddon) this.fitAddon.fit();
    this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
  },

  // A click on .btn-split does one of two things — open the picker, or
  // (openSplitPicker's own early return) close an already-open split — and
  // nothing on the button said which. `.split-open` + aria-pressed give it
  // the same active-state language as the codebase's other toggle buttons
  // (keyboard-accessory's Ctrl key, the voice-input mic).
  _updateSplitButtonState(open) {
    const btn = document.querySelector('.btn-split');
    if (!btn) return;
    btn.classList.toggle('split-open', open);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    const title = open ? 'Split: close the second session' : 'Split: open a second session beside this one';
    btn.title = title;
    btn.setAttribute('aria-label', title);
  },

  _installSplitDividerDrag(divider, wrap, paneB) {
    let dragging = false;
    let dragRaf = null;
    let pendingClientX = null;

    // Local-only reflow (flexBasis + both panes' xterm fit, no PTY resize
    // frame). Coalesced to one call per animation frame below — a raw
    // mousemove stream fires far faster than the browser repaints, and
    // without the rAF gate each event did a full xterm reflow on BOTH
    // panes AND sent Pane B a `{t:'z'}` resize frame (SplitTerminalPane has
    // no client-side "dims unchanged" skip), which fanned out into a
    // `tmux resize-window` child plus a SIGWINCH per frame — roughly fifty
    // of each dragging across half a wide viewport.
    const applyDragPercent = (clientX) => {
      const container = divider.parentElement;
      // The split can auto-collapse mid-drag (the other pane's session
      // ending, or the picker's own close button) — closeSplitPane() removes
      // `.terminal-split-container` from the DOM, which detaches `divider`
      // too, so `divider.parentElement` is null on the very next frame and
      // every drag threw here until mouseup finally removed the listener.
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const rawPercent = ((clientX - rect.left) / rect.width) * 100;
      const percent = window.CodemanSplitPane.clampDividerPercent(rawPercent);
      wrap.style.flexBasis = `${percent}%`;
      paneB.style.flexBasis = `${100 - percent}%`;
      if (this.fitAddon) this.fitAddon.fit();
      this._splitPane?.localFit();
    };

    const onMove = (e) => {
      if (!dragging) return;
      pendingClientX = e.clientX;
      if (dragRaf) return;
      dragRaf = requestAnimationFrame(() => {
        dragRaf = null;
        applyDragPercent(pendingClientX);
      });
    };

    const onUp = () => {
      dragging = false;
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = null;
        applyDragPercent(pendingClientX);
      }
      // Send the real PTY resize exactly once here, at drag end, for BOTH
      // panes — never per-move (matching the codebase's established
      // trailing-edge debounce convention, see throttledResize in
      // terminal-ui.js) so a fast drag doesn't flood dozens of intermediate
      // SIGWINCH/reflow states into scrollback or spawn a `tmux
      // resize-window` child per frame.
      this.sendResize?.(this.activeSessionId, { force: true })?.catch?.(() => {});
      this._splitPane?.fit();
    };

    divider.addEventListener('mousedown', () => {
      dragging = true;
      divider.classList.add('dragging');
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  },
});

const _originalOnSessionDeleted = CodemanApp.prototype._onSessionDeleted;
CodemanApp.prototype._onSessionDeleted = function (data) {
  if (this._splitSessionId === data.id) {
    this.closeSplitPane();
  } else if (this._splitPane && this.activeSessionId === data.id) {
    // Pane A's session ended: promote Pane B by closing the split and
    // selecting its session as the new (single) active pane. This is an
    // app-driven selection, not the user clicking a tab, so it must not
    // spend the promoted session's idle alert (see the Approvals Inbox
    // acknowledgement rule in CLAUDE.md — only a human opening a session
    // acknowledges it).
    const promoted = this._splitSessionId;
    this.closeSplitPane();
    // Closing Pane A's own tab (closeSession(), app.js) adds data.id to
    // _closingSessions BEFORE awaiting the delete, then owns the follow-up
    // selection itself once the delete lands — same race _onSessionDeleted's
    // own active-session handoff guards against (see its comment). Selecting
    // here too would fight it for which tab wins.
    if (promoted && !this._closingSessions.has(data.id)) {
      this.selectSession(promoted, { auto: true });
    }
  }
  return _originalOnSessionDeleted.call(this, data);
};

// I2: closes an active split BEFORE the primary pane rebinds to the same
// session Pane B is showing (clicking Pane B's own session tab while split,
// or any other selectSession() call that targets _splitSessionId). Without
// this, Pane A rebinds to a session that Pane B's independent WebSocket is
// still attached to — two live WebSockets to one session, each claiming PTY
// dimensions via its own `{t:'z',...}` resize frame.
const _originalSelectSession = CodemanApp.prototype.selectSession;
CodemanApp.prototype.selectSession = function (sessionId, ...args) {
  if (this._splitPane && this._splitSessionId === sessionId) {
    this.closeSplitPane();
  }
  return _originalSelectSession.call(this, sessionId, ...args);
};
