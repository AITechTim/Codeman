---
"aicodeman": patch
---

fix(input): make sure a prompt sent through the API actually leaves the composer. Claude Code 2.1.277 started ignoring Enter for the first 30 to 50 seconds after the composer paints while still accepting the typed text, so a prompt sent right after a session came up sat unsent in the pane and every waiter (send-and-wait, the agent skill, cron, the maintainer bot) burned its whole timeout on a turn that never started. The server now reads the pane after every programmatic write that carried Enter and presses Enter again, on a 2 to 60 second schedule, only while the composer verifiably still holds the text it sent; an empty composer, other text, or a pane with no composer at all ends it. The agent skill's `sendwait` gets the same loop for servers that predate this, and its preamble version moves to 1.30.1 so an already-seeded agent picks up the fresh copy.
