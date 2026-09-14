---
"aicodeman": patch
---

File previews, downloads and text reads now work in a **remote (SSH) case**.

A remote case's working directory is an absolute path on the *remote* host, but the
file routes resolved it with local `fs` — so a clicked path (or the File Viewer) always
failed as "File not found" even though the file existed and the session was clearly
working in that directory. `GET /api/sessions/:id/file-raw`, `file-content`,
`file-preview` and `file-thumbnail` now resolve and read through the same
`buildSshConnectionArgs()` connection the launch uses (`src/remote-files.ts`, one
`realpath`+`stat` probe per request returning both the file and the workspace root).

The guards are unchanged in strength: the workspace boundary is still enforced (now
resolved on the host that can actually resolve it), the sensitive-path blocklist and
the size cap (`CODEMAN_MAX_DOWNLOAD_BYTES`) still apply before any bytes are read, and
`Range` requests keep working, so remote `<video>`/`<audio>` seeking behaves like a
local file. An unreachable host is reported as `502` with the remote reason instead of
a misleading 404. Nothing is ever copied to the Codeman host.

Still not available for remote cases, and now said explicitly instead of 404-ing:
editing a file (`edit=1` / `PUT` answer 400, the viewer hides its Edit affordance),
office-document previews and generated thumbnails (both need the bytes on the server's
disk), the file tree / path picker, attachment registration for paths outside the
workspace, and `tail-file`. Docker cases are unaffected (their workspace is
bind-mounted at the same absolute path).
