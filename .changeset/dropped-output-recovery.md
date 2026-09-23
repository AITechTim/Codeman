---
"aicodeman": patch
---

fix(terminal): a dropped output frame is recovered, not just scheduled for recovery

`_onSessionTerminal` drops an incoming frame once the app-owned render queues already hold 128KB. That is the right call — the alternative is an unbounded backlog — but a hole in a TUI byte stream is a desynced cursor, and a desynced cursor is muffled text (#464). The drop was only half of it.

The recovery was a fire-and-forget timer: it nulled its own handle and then called `_onSessionNeedsRefresh()`, which opens with four early returns. Two of those — a buffer load already in flight, a refresh already owning this session — are **most likely to be true during exactly the output burst that caused the drop**, so the recovery was skipped precisely when it was needed, with nothing left to retry it, and those bytes were never replayed.

`_onSessionNeedsRefresh` now reports whether it actually repainted, and `_scheduleDroppedOutputRecovery` re-arms while it has not. Bounded, because every reason the refresh can be skipped is transient contention that clears in seconds and a permanently failing refresh must not become a loop against the API — and giving up at the cap leaves exactly what the old code left, so the floor is no worse. The same 2s debounce still collapses a burst of drops into one attempt.

This is the principle the review of #431 established for the WebSocket output-gap marker — only a repaint that actually happened settles the recovery — applied to the one recovery path that still relied on a timer having fired.
