---
"aicodeman": patch
---

Mobile: a long press on blank terminal space on Android Chrome no longer opens the keyboard and blanks the terminal (#471, fixes #360). The long-press guards are now armed before the press is checked for selectable text, so a press on empty space is swallowed the same way a press on a word already was.
