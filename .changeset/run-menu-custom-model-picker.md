---
'aicodeman': minor
---

feat(custom-model): pick a custom endpoint straight from the Run menu

#393 landed the backend for custom model endpoints and left it reachable only over the
HTTP API. This is the rest of it. Turn on Custom model endpoints in App Settings, save
an endpoint, and the Run dropdown grows a Custom Endpoints section built live off the
CLI registry, one entry per harness that can actually redirect plus each endpoint you
saved. Pick one and it launches that harness pointed at your server, asking which model
first when the endpoint has more than one. Endpoints re-discover themselves every five
minutes, and one unreachable endpoint never blocks the others. App Settings gains full
add, edit and delete for endpoints.

Seven of the harnesses (opencode, Codex, Gemini, Pi, Grok, DeepSeek and OMP) now launch
directly onto the endpoint with no restart at all, where before you watched a native
boot followed immediately by a second one. Claude still launches and then restarts in
place, which its own resume makes far less jarring.

Most of this release's work went into things that only show up against a real server,
and each was found that way rather than in tests: a freshly launched CLI reporting
itself busy for its own startup and getting refused; Claude Code assuming a large
context window for a model it does not recognise and silently overflowing a small one;
a model whose real context is below what Claude Code's own system prompt costs, which
no setting can fix and which now warns before launching into a certain failure; and the
big one, llama.cpp running exactly one model at a time, so applying a selection can
unload the model another session is using. That last case now asks first, tells you
which session it affects, and keeps a "loading model" notice on screen for the whole
swap window, so a prompt sent mid-swap reads as loading rather than as an answer from
whatever was loaded a moment ago. A background sweep also catches the reverse: your
session's model being evicted later by somebody else's ordinary use.

Two things worth knowing if you drive this over the HTTP API or run multi-user. The two
questions an apply can ask (the model's context window is too small, and loading it will
unload the model another session is using) are now answered by separate
`confirmedContext` and `confirmedSwap` fields rather than one `confirmed`. They shared a
flag until now, and since the context check runs first, confirming that one silently
agreed to evict another session's model as well. The old `confirmed` still means both.
And `CLAUDE_CONFIG_DIR` is now admin-only in multi-user mode: it joined claude's
privileged env keys, so a non-granted owner can no longer set it through `envOverrides`,
and an already-persisted one is dropped on reboot-restore, which returns that session to
the default Claude account rather than the per-client one it was pointed at. Single-user
installs are unaffected.

Remote SSH and Docker sessions are refused for now, since their restart reattaches a
durable tmux rather than relaunching the agent.
