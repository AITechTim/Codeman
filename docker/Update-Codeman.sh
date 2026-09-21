#!/usr/bin/env bash
#
# The scripted major-update path for the Docker Compose deployment.
#
# docker/README.md and docs/docker-self-update.md both point operators here for
# anything the in-app updater itself refuses to apply: a changed
# `server.Dockerfile`, a changed `docker-compose.yaml`, or a new required
# `.env.example` key. None of those can be applied by a container restarting
# itself — a restart reuses the existing image and configuration (see "The
# environment gate" in docs/docker-self-update.md) — so this script does the
# three things an in-place update cannot: stop the stack, force a real image
# rebuild with no layer cache, then hand off to Start-Codeman.sh for the same
# careful PUID/PGID, override-file and fingerprint handling every other start
# goes through.
#
# This is the scripted form of "Resetting the build artefacts" in
# docs/docker-self-update.md (`docker compose down -v`, then
# `Start-Codeman.sh`), plus the unconditional `--no-cache` a major update
# warrants: `Start-Codeman.sh` on its own only rebuilds without the cache flag,
# and only clears the two build-artefact volumes when it detects the checkout's
# HEAD or `package-lock.json` moved — exactly right for an ordinary `git pull`,
# too conservative when the ask is "start over, certain of what ships".
#
# Usage: docker/Update-Codeman.sh [--volumes]
#   --volumes, -v   Also remove the codeman-node-modules/codeman-dist named
#                   volumes, so the fresh image's own node_modules/dist are
#                   what actually run instead of sitting unused behind a
#                   Docker-seeded volume's old content (Docker only seeds a
#                   named volume from the image while that volume is EMPTY).
#                   Safe: those two are the ONLY named volumes this stack
#                   declares (`docker-compose.yaml`) — application data and
#                   case workspaces are host bind mounts, never touched by
#                   `docker compose down`, with or without this flag.

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
env_file="$script_dir/.env"
compose_file="$script_dir/docker-compose.yaml"

remove_volumes=0
for arg in "$@"; do
  case "$arg" in
    --volumes | -v)
      remove_volumes=1
      ;;
    *)
      printf 'Error: unrecognised argument: %s\n' "$arg" >&2
      printf 'Usage: %s [--volumes]\n' "$0" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$env_file" ]]; then
  printf 'Error: Docker environment file is missing: %s\n' "$env_file" >&2
  printf 'Create it from %s/.env.example before running this script.\n' "$script_dir" >&2
  exit 1
fi

# Same override-file discovery as Start-Codeman.sh, and deliberately kept in
# step with it: a stack started through one script and updated through the
# other must resolve to the exact same Compose files, or `down` here and `up`
# there could target different configurations. Compose's own precedence
# (measured on v5.5.0 with both present: it uses .yml and ignores .yaml).
override_yml="$script_dir/docker-compose.override.yml"
override_yaml="$script_dir/docker-compose.override.yaml"
if [[ -f "$override_yml" && -f "$override_yaml" ]]; then
  printf 'Warning: both %s and %s exist; Compose uses .yml and ignores .yaml.\n' \
    "$override_yml" "$override_yaml" >&2
fi
compose_files=(-f "$compose_file")
for override_file in "$override_yml" "$override_yaml"; do
  if [[ -f "$override_file" ]]; then
    compose_files+=(-f "$override_file")
    printf 'Using Compose override file: %s\n' "$override_file"
    break
  fi
done
compose_command=(docker compose --env-file "$env_file" "${compose_files[@]}")

printf 'Stopping the stack...\n'
if [[ "$remove_volumes" == '1' ]]; then
  printf 'Also removing the codeman-node-modules/codeman-dist volumes (--volumes).\n'
  "${compose_command[@]}" down --volumes
else
  "${compose_command[@]}" down
fi

# --no-cache, always: a plain `build` reuses cached layers (npm install, apt
# packages, the CLI installs baked into the image) and can silently keep them
# frozen at whatever they were the day the cache was populated — exactly wrong
# for a major update, whose whole point is being certain of what actually
# ships. `scripts/build-agent-image.mjs` makes the same call for the same
# reason (see its entry in CLAUDE.md's Additional Commands table).
printf 'Building a fresh image (--no-cache)...\n'
"${compose_command[@]}" build --no-cache

# Start-Codeman.sh does everything a plain `up -d` does not: resolves
# PUID/PGID from CODEMAN_APPDATA_PATH's owner, pre-creates CODEMAN_CASES_PATH
# with the right ownership, resolves DOCKER_SOCKET_GID, records the
# server.Dockerfile/docker-compose.yaml fingerprint the in-app updater's gate
# reads on every future update, and clears the build-artefact volumes itself
# if it finds the checkout's source moved since the last start. Reimplementing
# any of that here would only risk drifting out of step with it — hand off
# instead, exactly as docs/docker-self-update.md's own reset procedure does.
printf 'Handing off to Start-Codeman.sh...\n'
exec "$script_dir/Start-Codeman.sh"
