---
"aicodeman": patch
---

The installer's hint for a launcher-only CLI (DeepSeek today) now says why it is a docs link rather than a command you can run, and points at the thing that resolves it: the package installs a launcher that still needs a terminal profile, and Codeman's Run menu can add one in a click. Driven by a generated `CLI_LAUNCHER_ONLY` flag rather than an id check, so it covers any future entry of that shape. Also removes three dead lookup helpers and two never-read generated arrays from `install.sh`, skips a disabled entry's probe instead of filtering it afterwards, and corrects a comment that claimed the non-interactive default is always Claude Code (on a wget-only host its curl one-liner is filtered out first).
