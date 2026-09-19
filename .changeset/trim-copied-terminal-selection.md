---
"aicodeman": patch
---

fix(terminal): trim the padding and shared indent out of a copied selection

Copying several rows out of a pane put a wall of spaces on the clipboard and
repeated the program's own margin on every line. xterm hands back whole screen
rows and trims only the cells that were never written to, so the real spaces a
full-screen TUI paints across the unused part of a row count as content:
measured against Claude Code in a 282-column pane, single lines arrived
carrying 138 trailing spaces on top of a two-space transcript indent. Pasting
that into a chat client or an editor meant deleting the whitespace by hand,
while Windows Terminal, iTerm2 and GNOME Terminal all trim it for you.

A copy now drops the trailing run from every line. It also removes the leading
run, but only the one that every selected row shares and only when the
selection covers more than one row, so shell output is untouched, a single line
keeps the indentation you can see, and anything nested inside a copied block
keeps its relative indentation. A drag that starts inside a row keeps that
partial first line exactly as it was. An `Alt+drag` rectangular selection is
copied verbatim, because its columns lining up is the point of that gesture.

The main terminal's four copy paths go through it: the Ctrl+C chord,
right-click, the phone selection button and Auto Copy. The browser's own
Edit menu copy, a copy shortcut you disabled in settings, and the subagent
windows still copy the raw rows, as they did before. A selection holding nothing but padding is now
refused rather than copied as bare line breaks, and it clears the selection on
the way out so Ctrl+C goes straight back to interrupting. Auto Copy reads its
own toggle before it reads the selection, so a pane nobody is copying from
costs nothing on mouseup.
