---
"aicodeman": patch
---

fix(terminal): the PTY and the browser terminal must never disagree about size (#464)

"Text gets muffled sometimes" was arithmetic, not a dropped frame. Claude Code's TUI wraps its frame at the width the PTY reported and erases the previous frame by walking the cursor up the rows it believes that frame took, so a browser terminal of a different width makes the erase come out short and each repaint paints over rows nothing cleared — the doubled lines and half-overwritten prose in the report.

Four ways the two drifted apart, all silent: `fitAddon.fit()` resized xterm to the raw proposal while every server-facing path reported it floored at 40x10 (measured in Chrome at 430px — font size 44 proposed 13 columns, the server was told 40, xterm stayed at 13); `throttledResize` and `sendResize` reflowed locally while deliberately withholding the SIGWINCH; the font setters moved the cell size and told the server nothing; and `Session.resize` declined small-viewport requests under an active desktop sizing claim without telling the asking client, because resize was write-only.

`syncTerminalGeometry()` is now the one function that changes the terminal's size — it fits, floors and applies as a single step, and a test sweeps every module for a bare `fit()`. Both transports answer a resize with the geometry the PTY actually holds, and the client adopts it; a pane wider than the screen earns horizontal reach for as long as the mismatch lasts, because correct-and-reachable beats correct-and-clipped beats garbled.

Also in this release: the response viewer's and clear-terminal's uncapped captures now carry the full-history deadline rather than the tail one; a `?full=1` capture that outruns its deadline falls back to the bounded tail instead of leaving a blank pane, a dead socket and a tab stuck reporting `aria-busy`; the output-gap marker is cleared at the repaint that settles it rather than in a `finally` that ran on failure too; and the replay-clear invariant is pinned in the gate.
