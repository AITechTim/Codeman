---
"aicodeman": patch
---

Auto-name sessions from the first prompt (#376, opt-in). With the new synced **Auto-name Sessions** setting on (App Settings → Appearance → Tabs, default off), a tab that still carries its generated name takes a title from the first real prompt you submit, keeping the case prefix: `w3-myapp` becomes `w3-myapp: fix the login redirect`. The strip shows the title with the prefix in the tooltip, and the next session in that case still counts up. It happens once per session, only for prompts you type or send through the input API (never a Ralph, respawn, cron or approval answer), never for shells, and a name you set yourself is never touched. Slash commands such as `/clear` do not become titles. The title is derived locally from the prompt's first sentence; no text leaves the machine. `nameSource` (`placeholder` / `auto` / `manual`) is a new additive field on session state.

Landed with the fixes the review of #376 asked for: first prompt only (not every prompt), a user-input gate so Ralph, respawn, cron and approval writes cannot name a tab, the prefix form so the case identity and `w<n>` counter survive, and a keystroke tracker that handles a bare Esc, bracketed pastes, wheel reports, Tab and history recall instead of mis-titling the tab.

### Thanks

- @shenlvkang-collab for #376, the auto-naming idea and the ownership plumbing (`nameSource`, the listener wiring, the restore path) it shipped with.
