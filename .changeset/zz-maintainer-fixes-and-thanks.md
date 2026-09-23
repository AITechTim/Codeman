---
"aicodeman": patch
---

Maintainer fixes applied while landing this batch:

- Terminal (#431): while another device holds the pane's width, a resize retry no longer re-fits xterm to the container and re-wraps the whole buffer every 30 s, and no longer clears scrollback for a redraw that never comes. The PTY's spawn geometry is now recorded at attach, so `ptyGeometry` never reports a size the PTY never held.
- Terminal (#470): the `TERMINAL DROP` crash-trail line is logged once per recovery window instead of once per dropped frame (which wiped the rest of the trail within a second), and a refresh that died at its fetch deadline is no longer retried.
- Sessions (#467): the resume pin also covers the branch where tmux lost the whole session, the conversation id Codeman reports follows what the relaunch actually resumed, and the test setup strips `CLAUDE_CONFIG_DIR` so the suite stays green for anyone running a separate Claude config dir.
- Sessions (#466): detailed sidebar and rail rows show an `exited` pill instead of `idle`, the exit is announced to screen readers, and the user manual's tab-appearance table lists the new state.
- Approvals (#473): a failed pane capture clears the `watching` badge rather than keeping a stale one (a failure now falls toward an alert, not toward silence), and the header bell's count leaves acknowledged items out, matching the TUI.
- Run menu (#463): the Gemini and Antigravity run buttons no longer render two-tone on phones, Gemini's registry accent matches its tab badge, and a test now guards the stylesheet trap for every run mode.
- Docker (#465): `Update-Codeman.sh` removes exactly the two build-artefact volumes it names instead of every named volume in the project, reports a failing `docker compose` instead of exiting silently, and its docs and comments were corrected. (#472): the multi-user notes say that a non-admin's seeded Docker case also receives the gh/az sign-in when those switches are on.

### Thanks

- @irisitymichaelgrundberg for four PRs in this release: the `watching` badge that stops background work from raising false alerts (#473, from their own report #468), the exited-agent badge (#466) and the dead-pane resume fix (#467), both from their report #446, and the transcript-gutter strip for copied text (#469), a follow-up to their #451.
- @rounakdatta for the terminal resilience work (#431) and the dropped-frame recovery (#470), both from their report #464, and for answering four rounds of review in full.
- @opticon454 for private-repository support in the Docker images (#472), the `Update-Codeman.sh` script (#465) and the run-button colour fix (#463).
- @DodgyBadger for the Android long-press fix (#471), from their own report #360.
