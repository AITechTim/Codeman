---
"aicodeman": patch
---

fix(terminal): replay a pane capture at the geometry it was taken at

Opening a session could draw a frame built for a pane bigger than your terminal. A
taller pane wrote its overflow rows onto the last line and lost the rows underneath
(against a 50-row pane, a 30-row terminal rendered 28 of a 45-line command and drew
the survivors twice), and a wider one wrapped every row and scrolled the whole frame
up by one. The terminal response now reports the geometry the capture was really
taken at, so the browser can see the mismatch and replay once at the size that stuck.
A pane that cannot be sized to fit is diagnosed once per session instead of on every
tab switch.
