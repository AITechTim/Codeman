---
"aicodeman": patch
---

fix(terminal): let Claude use truecolor so its themed backgrounds render

Claude draws the user's own messages as a block of background color, and it renders as an
approximation of the theme color at best. Claude's registry entry deleted `COLORTERM`, which
left it the only agent CLI here besides `opencode` not asking for 24-bit color, so every RGB
color its theme asks for was quantized down to whatever palette `TERM` alone implies. Claude
now exports `COLORTERM=truecolor` like codex, gemini, antigravity, pi, grok, deepseek and omp
already do, and the block renders in the color the theme actually names.

How bad the quantization was depends on `TERM`, which is why this looks different on different
machines. On tmux 3.2 and newer, whose `default-terminal` defaults to `tmux-256color`,
supports-color reports 256 colors and `rgb(55, 55, 55)` lands on `ESC[48;5;237m`: visible, but
not the color the theme asked for. Where `TERM` resolves to a 16-color entry instead (tmux
older than 3.2, or a `~/.tmux.conf` setting `default-terminal screen`, which Codeman's tmux
server does read), every dark background collapses to `ESC[40m`, the terminal's own black, and
the block disappears entirely. That is the case this was reported from, and a custom Claude
theme could change the color there with nothing on screen moving.

Those seven CLIs also unset `NO_COLOR`; Claude does not, so a user who exports `NO_COLOR`
globally keeps the monochrome panes they asked for. `CLAUDECODE` stays unset, because Claude
reads it as a signal that it is running nested inside itself.

`buildClaudeEnv()`, the direct-PTY fallback used when tmux is unavailable, now reads the same
registry entry as the tmux pane and its attach client instead of deleting `COLORTERM` from a
hand-maintained list of its own. It applies that entry before assigning Codeman's own
variables, mirroring `buildEnvExports()`, so a `clis.json` override naming one of them cannot
strip it on this path while the tmux pane keeps it. A remote pane still exports nothing,
because `buildRemoteLaunchCommand()` never carried these declarations, so an SSH-remote Claude
session keeps the old rendering.

PR #3 introduced the `unset COLORTERM` in February, citing xterm.js#484 for the claim that
xterm.js mishandles truecolor, and aiming to fall back to 256-color mode. xterm.js closed that
issue in April 2019, Codeman now depends on `@xterm/xterm` 6, and `TmuxManager` sets
`terminal-overrides ",*:Tc"` on its own tmux server, so 24-bit color already reaches the
browser for the CLIs that ask for it.
