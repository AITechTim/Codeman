---
"aicodeman": patch
---

Sessions: recovering a Claude session whose tmux pane had died relaunched `claude --session-id <id>`, which Claude refuses once that id has a transcript, so the pane died again straight away and the conversation was stranded. The relaunch now resumes the conversation (`--resume <id> || --session-id <id>`), including when tmux lost the whole session (#467).
