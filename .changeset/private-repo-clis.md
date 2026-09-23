---
"aicodeman": patch
---

Docker: optional GitHub CLI and Azure CLI for private repositories (#472). Both are off by default. With `CODEMAN_INSTALL_GH=1` / `CODEMAN_INSTALL_AZ=1` as build args in `docker-compose.override.yml`, the server image gets `gh` and/or `az` (with the `azure-devops` extension) wired in as git credential helpers, so after one `gh auth login` or `az login` from a shell session, Add Case → Clone Repo can clone private GitHub and Azure DevOps repositories. `CODEMAN_AGENT_IMAGE_INSTALL_GH` / `_AZ` do the same for the Docker-case agent image, and only then are the sign-ins copied into new case containers. In multi-user mode a non-admin's clone runs with the credential helpers cleared. This changes `server.Dockerfile`, so Compose deployments need a `Start-Codeman.sh` rebuild rather than an in-app update.
