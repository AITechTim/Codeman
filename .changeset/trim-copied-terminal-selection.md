---
"aicodeman": patch
---

fix(terminal): trim the padding out of a copied selection

Copying out of a pane put a wall of spaces on the clipboard. xterm hands back
whole screen rows and trims only the cells that were never written to, so the
real spaces a full-screen program paints across the unused part of a row count
as content: measured against Claude Code in a 282-column pane, single lines
arrived carrying 138 trailing spaces. Pasting that into a chat client or an
editor meant deleting the whitespace by hand, while Windows Terminal, iTerm2 and
GNOME Terminal all trim it for you. A copy now drops the trailing run from every
line, on all four paths (the Ctrl+C chord, right-click, the phone selection
button and Auto Copy), while leading indentation is left exactly as it is. An
Alt+drag rectangular selection is copied verbatim, because its columns lining up
is the point of that gesture. A selection holding nothing but padding is refused
rather than copied as bare line breaks.
