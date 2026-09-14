# Herdr terminal attachment lifecycle

Herdr owns the durable terminal and agent. Codeman owns at most one direct
attachment per Session, shared by its browser sockets. Interactive HTTP starts,
shell starts and browser acquisition join the same pending startup operation.
A pending retirement must finish before a replacement starts. Callbacks are
bound to the process that registered them, so a retired client cannot clear or
write into the replacement's state.

The optional `terminalTransport` session field is `detached`, `connecting`,
`connected`, or `conflict`. WebSockets emit `{t:"ts",state,pid}` as it changes.
Agent lifecycle state remains independent. Session-list responses retain the
existing short cache lifetime; the individual-session endpoint and WebSocket
transport messages expose current attachment state.

Normal attachment requests omit `--takeover`. An exited client with Herdr's
bounded takeover/already-owned diagnostic enters `conflict`. Browser input
stays in the existing durable queue and HTTP input returns 409 without applying
or acknowledging it. The connection indicator's Reconnect button sends
`POST /api/sessions/:id/interactive` with `{takeover:true}`; that one acquisition
may reclaim control. Network reconnects never set takeover.

The last browser release starts a five-second grace timer. Its expiry, or
Codeman shutdown, kills only the attachment and waits for it to exit. Herdr
then releases its resize lock. A retirement that does not exit within ten
seconds remains a barrier rather than allowing another attachment to overlap.

## Shared session names

Automatic Codeman titles and Herdr agent names use `<workspace-alias>-<task>`.
The mapping captures the original Herdr workspace group, independent of the
foreground working directory, and retains it through workspace renames, pane
moves, and restarts. New groups created by Codeman use the starting folder name.

Aliases are `ws` (workspaces), `kb` (knowledge-base), `cv01`/`cv02`
(cvision_v01/v02), and `ap` (annotation-platform). Generated `w1-` style prefixes
are removed before matching. Other labels normalize to at most eight characters.
Task shortening removes conversational filler and retains up to four meaningful
words. The total name fits Herdr's 32-character limit at word/hyphen boundaries,
including the workspace prefix and any stable collision suffix.

Name version 3 migrates automatic names once. Existing mappings without origin
information adopt their workspace at migration time. Manual names retain the
existing manual-name rules. Missing workspace labels and failed lookups defer
automatic renaming; the initial workspace ID is retained for a later retry.

Herdr's devbox sidebar places `state_icon` and `agent` together on one row,
with the agent token styled `fg = "#cdd6f4", bold = true, dim = false`. Each name
appears once in bright text without a repeated workspace/tab row. Session and
terminal IDs do not change.

## Verification

`npm test -- test/herdr-transport.test.ts test/herdr-mux-manager.test.ts
 test/routes/ws-routes.test.ts test/routes/session-routes.test.ts
 test/input-send-order.test.ts test/ws-state-lifecycle.test.ts
 test/session-resize-arbitration.test.ts`

Use a disposable named Herdr server and a separate Codeman port/data directory
for browser acceptance: type into the terminal, open two browsers, reload,
resize, take over with an external direct client, type while blocked, click
Reconnect, and close both browsers. Verify one attachment, ordered pending input
with no duplicate delivery, matching PTY geometry, and final attachment release.
Never run these actions against a user's pane.

For Cancilico images, build the pinned source with `codeman-herdr.patch`, then
run `scripts/build-codeman-transport-overrides.mjs <built-checkout>` in
cancilico-openshell. The generated override JSON and mux manager must accompany
the updated source patch. The runtime patcher checks the package version,
installs these compiled modules, updates compressed assets, and remains
idempotent. All inputs contribute to the staged runtime's content hash.
