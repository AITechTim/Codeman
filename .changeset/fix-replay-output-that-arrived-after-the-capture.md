---
"aicodeman": patch
---

fix(terminal): keep the output a pane capture could not contain

Live terminal events are queued while a buffer load runs, and the load discards
that queue when it ends. That is right when the loaded buffer is the server's
accumulated byte history: the route appends to that history right up to the
moment it serializes the response, so the queued events already appear in it and
replaying them would duplicate output.

A tmux pane capture is a photograph, current only as of the instant
`capture-pane` ran. Output printed afterwards was queued and then dropped, with
nothing scheduling a re-fetch, and the CLI's next partial redraw landed on a
frame the terminal never received. A `?full=1` load returns the capture alone,
so it lost everything from the capture to the end of the chunked write. A
`?tail=` load carries the byte history in front of the capture, so it lost
everything from the response to the end of that write. A shell session shows
this most plainly, because its output is linear and nothing repaints it.

Queue entries now carry their arrival time, and `_finishBufferLoad` takes a
`since` cutoff so a capture load replays exactly the tail that arrived after the
response headers. All four paths that fetch a terminal buffer and write it use
the same rule, through one shared `_bufferLoadFinishOpts` helper: selecting a
session, the backpressure refresh, the clear-terminal reload, and the
full-history re-pull. The backpressure refresh matters most, because it exists
to restore output the client already dropped once and could drop more while
doing it.

Two things had to change for that tail to still exist when the load ends.
`chunkedTerminalWrite` is what ends the load for any non-empty buffer, so it
takes the flush policy and applies it at its own finish sites.
`_beginBufferLoad` no longer empties the queue when the same load re-enters it,
which it does on every write, because that reset discarded the fetch window
before anything could replay it.

A path that replays its queue and then restores a scroll position re-takes the
sticky-scroll baseline (`_syncStickyScrollBaseline`). The replay runs with the
terminal freshly reset, so it reads as sitting at the bottom, and the next flush
would scroll there and undo the restore. The backpressure refresh and the
full-history re-pull are the two paths that restore a position, and both are
ones a reader reaches while scrolled up.

One duplicate window stays open and is not closable from the browser. The server
appends output to the byte buffer in the same tick it emits, but broadcasts on a
batch timer, 8ms over WebSocket and 16 to 50ms over SSE. A batch already pending
when `capture-pane` ran therefore leaves the server after the reply and is
replayed although the capture holds it. It is one batch interval wide, against a
recovery window that spans the whole chunked write, and closing it means
flushing that session's pending batch before taking the capture.
