---
"aicodeman": patch
---

Approvals: a session that is idle only because it is waiting on its own background work (Claude Code's `1 monitor` footer chip, or a Codex background terminal) no longer raises the yellow NEEDS YOU alert or a push (#473, fixes #468). Its idle item is opened already acknowledged, and the tab, the home screens and the rail show a small `watching` badge next to the state instead. The item still exists in the Approvals Inbox, and the TUI's pending count now leaves acknowledged items out.
