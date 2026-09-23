---
"aicodeman": patch
---

Sessions: a tab whose agent has exited (the CLI quit, but tmux kept the pane) now says so with a muted dot and an `exited (137)` badge, instead of looking like an idle session (#466, part 1 of #446). The state is published as `paneExit` on the session and survives a restart. Nothing closes such sessions yet; that is part 2.
