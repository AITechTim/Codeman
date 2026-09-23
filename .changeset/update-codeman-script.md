---
"aicodeman": patch
---

Docker: new `docker/Update-Codeman.sh` for the major-update path the docs used to describe by hand (#465). It rebuilds the image with `--no-cache` before taking the stack down, clears the build-artefact volumes, refuses to run when another checkout's Compose project already owns the same name, and then hands over to `Start-Codeman.sh`.
