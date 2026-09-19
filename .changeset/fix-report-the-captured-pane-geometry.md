---
"aicodeman": patch
---

fix(terminal): replay a pane capture at the geometry it was taken at

A visible-frame capture repaints each row at an absolute position, counting up
to the pane's height and out to the pane's width. A terminal shorter than that
clamps every address past its own height onto its last line, so the overflow
rows overwrite one another and the rows underneath are lost. Against a 50-row
pane, a 30-row terminal rendered 28 of a 45-line command and drew the surviving
frame twice. A narrower terminal damages the same frame a second way: each row
is painted out to the pane's own width, so the browser wraps every painted row,
and the wrap on the last one scrolls the whole frame up by a row.

Nothing in the response said what geometry the frame was built for, so the
client could not detect either case. A capture now reports the geometry it was
really taken at through `capturedGeometry` on `PaneCaptureOptions`, and the
terminal response carries it as `captureCols` and `captureRows`. Both fields are
absent unless the response really carries a capture, since a body that was never
positioned has no geometry to describe. When a captured pane is taller or wider
than the terminal, or the size that produced the capture did not survive the
load, `selectSession` replays once at the size that stuck.

That comparison runs on a visible-frame response only. A full-history response
is linear scrollback closed by a relative cursor move, and a byte-history
response carries no row alignment at all, so a size mismatch damages neither and
a replay repairs neither. The distinction matters because the first load of
every non-shell session per page takes the full-history path, where a replay
would capture the whole tmux scrollback a second time.

Two guards keep the replay to the one pass that can converge. `resizeRetry` caps
it at a single attempt, so two competing fits cannot trade replays forever. A
pane already drawing at the size the client just requested is left alone, which
is the signature of a clamp rather than a race: `getTerminalDimensions()` floors
at 40x10 while `fitAddon.fit()` does not, so a terminal narrower than 40 columns
or shorter than 10 rows reports a pane permanently bigger than itself and would
otherwise replay on every tab switch without ever converging.

One case is still reported rather than repaired. A pane can be too tall because
`Session.resize` declined the resize outright, which it does for a small
viewport while a desktop viewport's size claim is live. The retry re-sends the
same declined resize and captures the same pane, so it costs the one capped
attempt and the frame is shown as it is. Repairing it means deciding who owns
the pane size while a desktop claim is live, which is a policy question this
does not touch. The reported geometry still helps, because the client can see
the mismatch at all rather than being blind to it.
