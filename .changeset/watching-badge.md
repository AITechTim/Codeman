---
'aicodeman': minor
---

A session watching work it started itself no longer asks you to look at it. An agent that arms a monitor, backgrounds a shell or hands a task to a cloud session is told to end its turn, so the pane goes quiet, Claude Code's idle notification lands a minute later, and the session shows up under NEEDS YOU with nothing for anyone to answer.

Claude prints what it is still running on the last row of its screen, and the CLI registry now carries that row as an optional `capabilities.workDetect.watchingLine`. The idle probe reads the label ("1 monitor", "2 shells") off the capture it already takes when a turn ends, and it reaches the session payload as `watching`.

The prompt that follows then opens already acknowledged. It stays in the Approvals drawer, stays answerable and stays Read My Mind context, and only the alert it would have armed is spent: no tab alert, no desktop notification, no push, and no NEEDS YOU row on any surface, `codeman tui` included. The card says why, reading "quiet, watching 1 monitor" rather than implying somebody looked. It re-arms by itself, because the next idle prompt supersedes this item and is built fresh. A permission or question dialog still goes red whatever else the agent started.

Sessions also wear a `watching` badge beside their state pill on the phone overview, the desktop home rail and the rich sidebar and rail rows.

Fixes a pre-existing bug in the same gate: `classifySession()` never looked at `acknowledgedAt`, so an idle alert cleared by opening the session on another device stayed lit in `codeman tui` alone.
