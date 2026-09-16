# Custom Model Endpoints

Point a harness at your own OpenAI-compatible server instead of its native cloud backend, for
one session at a time. "Custom endpoint" covers **local** hardware (llama.cpp, Ollama, vLLM,
a home GPU rig, DGX Spark, Strix Halo) and **cloud** services (Azure AI Foundry's
OpenAI-compatible endpoint, OpenRouter, a company gateway) alike, anything answering
`GET /v1/models` and `POST /v1/chat/completions` in the standard shape.

**Off by default.** Turn it on in App Settings → Models → **Custom model endpoints**.

## Adding an endpoint

Still in App Settings → Models → Custom model endpoints:

1. **+ Add endpoint** — give it an id, a label, and the base URL (`http://192.168.1.50:8080`,
   say). An API key is optional; most local servers don't check one.
2. **Discover** — fetches the endpoint's own model list over `GET /v1/models` and stores it.
3. Pick a **default model** from what was discovered. This is the model the Run-menu entry
   applies directly when only one model is discovered; with two or more, it's just the one
   pre-marked in the picker dialog described below, not a silent default.

Endpoint management is admin-only in multi-user mode, the same as remote hosts and Docker
hosts — these are machine-level infra, not a per-user setting.

**Model lists refresh themselves.** Every saved endpoint is re-discovered automatically every
5 minutes in the background, so a model the server starts serving later — or stops serving —
shows up without another manual click of **Discover**. One endpoint being unreachable on a
given cycle (powered off, wrong network) never blocks the others from refreshing.

**Context length is picked up automatically where it can be, safely.** Against a
llama.cpp/llama-swap server, discovery also learns each *currently loaded* model's real
context window and applies it to the launched session (Claude Code today — see below), so
the harness stops assuming a large default window for a model name it doesn't recognise and
overflowing a much smaller real one. It's deliberately never probed for a model that isn't
already loaded, since asking a llama-swap server about an unloaded model can trigger an
actual, slow model swap as a side effect — a model just not currently loaded keeps whatever
context length an earlier cycle already learned for it instead.

## Running a session against one

With the setting on and at least one endpoint carrying a discovered model, the **Run**
dropdown grows a **Custom Endpoints** section: one entry per harness that can redirect to a
custom endpoint, per saved endpoint, e.g. "Claude Code (llama.cpp)". Picking one starts a
session on that harness exactly the way its own entry would. It is a one-off "try this
endpoint" action, not a sticky mode — the plain **Run** button still means "this harness,
native cloud" afterward, and a fresh session never inherits whatever the last one was
pointed at.

**Which model it uses depends on how many the endpoint has discovered.** With exactly one,
the session launches straight away on that model — nothing to choose. With two or more, a
small dialog asks which one to use for this launch before starting the session; the
endpoint's default model, if set, is marked but not auto-picked, so a launch can deliberately
use a different one without changing the saved default.

Applying a selection **restarts the harness's process in place** — same tab, same
conversation where the harness supports resuming one, fresh environment. That restart is
necessary, not incidental: every supported harness reads its endpoint config at process
start, never per turn, so there is no live hot-swap while a turn is running.

Picking an entry that launches a **brand-new** session waits (up to 20 seconds) for it to
finish its own startup before applying — a freshly started CLI reports itself as busy for its
boot sequence, and applying to a genuinely busy session is refused so a real, in-progress
turn is never interrupted out from under you. A session that is still busy after that wait
(a very slow-starting CLI, or one you started typing into right away) surfaces that refusal
as an ordinary error, which now stays on screen with a close button instead of vanishing
after a few seconds — read it, it names the actual reason rather than a generic failure.

Entries are hidden entirely for a session in a **remote (SSH) or Docker case** — support for
redirecting those hasn't landed yet, see below. The picker also only appears in the desktop
**Run** dropdown; the phone home screen builds its own run picker separately and does not
currently offer these entries.

**Claude Code specifically gets two extra fixes applied automatically:**

- Its discovered context length (see above) is passed through as
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, so it doesn't send a full-size prompt against a much
  smaller real local context and overflow it.
- Its session runs with an isolated `CLAUDE_CONFIG_DIR`, so the injected API key never sits
  in the same directory as a stored claude.ai login — that combination is harmless for actual
  requests (the API key wins) but the CLI still prints a "both claude.ai and
  ANTHROPIC_API_KEY set" warning about it, which this avoids entirely. The isolated directory
  keeps a link back to your real session history so the response viewer and similar features
  still work for that session.

## Which harnesses actually work

| Harness | Status |
| ------- | ------ |
| **Claude Code, opencode, Pi, Grok, OMP** | Verified end-to-end against a real local server. |
| **Codex** | Config is correct, but Codex only speaks the Responses API, which llama.cpp-style servers don't implement. A protocol gap, not a Codeman bug. |
| **Gemini** | Fails with an auth error gemini-cli raises once redirected. Unresolved; don't rely on it yet. |
| **DeepSeek** | Reaches the server but gets a consistent 404. Root cause not identified. |
| **Antigravity** | No known custom-endpoint mechanism at all. Not offered. |

Which harnesses show up in the Run-menu picker is read live off Codeman's own CLI registry,
not a fixed list here, so this table can go stale before this page does — a greyed-out or
missing entry is the more current answer.

## What it does not do

- **No remote or Docker sessions yet.** Both restart their agent differently under the hood
  (reattaching a durable tmux session rather than relaunching the process), so redirecting
  them needs its own plumbing that hasn't been built.
- **No live hot-swap mid-conversation.** Applying a selection always restarts the process.
- **No button to un-point a session from the UI yet.** Clearing back to native cloud is an
  HTTP call (`POST .../custom-model {"clear": true}`) or deleting the session; the settings
  panel manages saved endpoints, not what a running session is currently pointed at.
- **Nothing is shared with your real cloud credentials.** The endpoint's own key, if any,
  never touches your Anthropic/OpenAI/Google login — a custom endpoint is a separate,
  explicit choice per session.

## Security

An endpoint's base URL can't point at a link-local or cloud-metadata address (both at save
time and against the address it actually resolves to), the same guard Web Tabs uses for
saved dashboards. Endpoint records and any per-session config files a harness needs are
written with owner-only permissions. See
[custom-model-endpoints-plan.md](https://github.com/Ark0N/Codeman/blob/master/docs/custom-model-endpoints-plan.md)
in the repository for the full design reasoning, including why this feature closed a
pre-existing gap in how session environment overrides were guarded rather than opening a new
one.
