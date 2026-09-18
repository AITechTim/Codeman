---
"aicodeman": patch
---

Maintainer fixes applied while landing the above. A session restored after a reboot keeps the name you gave it (the rebuild dropped the field that records who named a session, so a hand-renamed session came back looking auto-named and the next prompt overwrote it), and no longer types `continue` into itself on its own: a pending auto-resume stamp from before the reboot is dropped rather than re-armed, since the pane is new and one click could otherwise arm several unattended prompts at once. Auto-resume itself stays on and re-arms on the next real usage-limit message. The restore offer is also hidden in a detached single-session window, which has no tab strip to put restored sessions in, and a conversation that goes live while an earlier session in the same batch is starting is no longer restored a second time.
