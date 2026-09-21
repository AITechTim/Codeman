---
"aicodeman": minor
---

feat(mobile): a Compose key for writing prompts on a phone

The agent keyboard bars on phones replace their Paste key with Compose: a real multiline editor with autocorrect and spellcheck, per-session drafts kept in memory only, image attach that never writes into the terminal early, and a Send that delivers the text as one paste followed by Enter, so a long prompt no longer has to be typed blind into the terminal composer. Anything you had already typed into the terminal is picked up into the editor. Shell sessions keep the direct Paste key. This is the manual first slice from #359; the auto-open setting and terminal tap routing are a separate follow-up.
