---
'aicodeman': minor
---

A session watching work it started itself no longer asks you to look at it. An agent that arms a monitor, backgrounds a shell or hands a task to a cloud session is told to end its turn, so the pane goes quiet, Claude Code's idle notification lands a minute later, and the session shows up under NEEDS YOU with nothing for anyone to answer.

A CLI states what it is still running on its own screen, and the CLI registry now carries that row as an optional `capabilities.workDetect.watchingLine`. The idle probe reads the label off the capture it already takes when a turn ends, and it reaches the session payload as `watching`. Claude writes its chip on the last row (`· 1 monitor ·`, also shells, cloud sessions and background tasks); Codex pins `1 background terminal running · /ps to view · /stop to close` above its composer and declares the deeper window that needs. Both patterns were measured against live panes, and a CLI that declares none reports no background work, as every CLI did before. The label is read from the foot of the screen only, because it comes off the agent's own pane: `docs/cli-registry.md` sets out what a new pattern has to satisfy before it may be trusted to quiet an alert.

The prompt that follows then opens already acknowledged. It stays in the Approvals drawer, stays answerable and stays Read My Mind context, and only the alert it would have armed is spent: no tab alert, no desktop notification, no push, and no NEEDS YOU row on any surface, `codeman tui` included. The card says why on both surfaces, reading "quiet, watching 1 monitor" rather than implying somebody looked. It re-arms by itself, because the next idle prompt supersedes this item and is built fresh. A permission prompt or a question dialog still goes red whatever else the agent started.

One limit worth knowing: a question asked in plain prose is not a dialog, so an agent that starts a monitor and then writes "which branch should I target?" goes quiet along with the false alarms until the background work ends. `docs/wiki/Notifications-And-Approvals.md` says so where users will meet it.

Sessions also wear a `watching` badge beside their state pill on the phone overview, the desktop home rail and the rich sidebar and rail rows.

Fixes a pre-existing bug in the same gate: `classifySession()` never looked at `acknowledgedAt`, so an idle alert cleared by opening the session on another device stayed lit in `codeman tui` alone.
