---
"aicodeman": patch
---

Terminal copy: copying text out of a Claude Code or Codex pane no longer puts the pane's two-column transcript gutter on the clipboard, so pasted lines arrive flush instead of indented (#469). The width comes from the CLI registry (`capabilities.transcriptGutter`, 2 for claude and codex, measured on live panes) and is only a ceiling: a selection only ever shifts as a block, so its own indentation survives. Other CLIs and shells are untouched. It works in split panes and detached session windows too, and can be turned off per device in App Settings under Selection & clipboard.
