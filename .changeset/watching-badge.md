---
'aicodeman': minor
---

Sessions now say when they are watching work they started themselves. An agent that arms a monitor, backgrounds a shell or hands a task to a cloud session is told to end its turn, so the pane goes quiet, Claude Code's idle notification lands a minute later and the session shows up under NEEDS YOU with nothing for anyone to answer. Claude prints what it is still running on the last row of its screen, and the CLI registry now carries that row as `capabilities.workDetect.watchingLine`, so the idle probe reads the label ("1 monitor", "2 shells") along with the working line it already reads. The label reaches every session payload as `watching`, and the phone overview, the desktop home rail and the rich sidebar rows wear it as a `watching` badge in the accent colour. It sits beside the state pill and never replaces it, because an agent can arm a monitor and ask you a question in the same breath.
