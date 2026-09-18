---
"aicodeman": patch
---

fix(terminal): replay a pane capture at the geometry it was taken at

A visible-frame capture repaints each row at an absolute position, counting up
to the pane's height. A terminal shorter than that clamps every address past
its own height onto its last line, so the overflow rows overwrite one another
and the rows underneath are lost. Against a 50-row pane, a 30-row terminal
rendered 28 of a 45-line command and drew the surviving frame twice.

A pane wider than the terminal damages the same frame a second way. Each row is
painted out to the pane's own width, so a narrower terminal wraps every painted
row, and the wrap on the last one scrolls the whole frame up by a row.

Nothing in the response said what geometry the frame was built for, so the client
could not detect either case. A capture now reports the geometry it was really
taken at through `capturedGeometry` on `PaneCaptureOptions`, and the terminal
response carries it as `captureCols` and `captureRows`. When the captured pane is
taller or wider than the terminal, or the size that produced the capture did not
survive the load, `selectSession` replays once at the size that stuck.
`resizeRetry` caps that at one attempt, so two competing fits cannot trade
replays forever.

That comparison runs on a visible-frame response only. A full-history response is
linear scrollback closed by a relative cursor move, and a byte-history response
carries no row alignment at all, so a size mismatch damages neither and a replay
repairs neither. Gating on the source matters because the first load of every
non-shell session per page takes the full-history path, where an ungated
comparison would capture the whole tmux scrollback a second time. A response
whose capture reported no geometry now omits both fields rather than naming the
session's own PTY size, which describes no frame that was ever positioned.

That repairs the case where a capture won a race against the resize meant to
precede it. It does not repair a capture whose pane was too tall because
`Session.resize` declined the resize outright, which it does for a small
viewport while a desktop viewport's size claim is live: the retry re-sends the
same declined resize and captures the same pane. The reported geometry still
helps there, because the client can see the mismatch at all.
