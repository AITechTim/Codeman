---
"aicodeman": patch
---

fix(terminal): keep the output a pane capture could not contain. Opening a session, a backpressure refresh, a clear-terminal reload and a full-history re-pull all load the screen from a tmux pane capture, and anything the CLI printed between that capture and the end of the load used to be dropped, so its next partial redraw landed on a frame the terminal had never seen: missing or garbled output right after a tab switch or a refresh, plainest in a shell session. Each load now replays exactly the output that arrived after the capture, through one shared rule for all four paths, and a refresh that restores your scroll position no longer snaps back to the bottom afterwards.
