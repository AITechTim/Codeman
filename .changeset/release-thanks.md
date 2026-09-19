---
"aicodeman": patch
---

### Thanks

- @irisitymichaelgrundberg for three terminal fixes in one release: keeping the output a pane capture could not contain (#436), replaying a capture at the geometry it was taken at (#435, five rounds and a Playwright suite that fails against the merge base), and trimming the padding out of a copied selection (#451), where the scan-instead-of-regex call avoided a 2.9s freeze nobody would have traced back to a copy.
- @timkjr for a first contribution that found a real silent failure: the Instance count stepper next to the Run button had only ever applied to Claude, so on the other eight run modes it launched one session and said nothing (#454).
- @Randalix for Wake-on-LAN on remote hosts (#439), built and live-tested against a real sleeping machine, and for reading the whole diff again between rounds rather than only the parts that were asked about.
