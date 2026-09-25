#!/usr/bin/env bash
set -euo pipefail
umask 077

# migrate-runtime-to-docker.template.sh — TEMPLATE ONLY. NOT INSTALLED, NOT ACTIVE.
#
# Safe one-time additive migration of the HOST .runtime directory into the
# Docker named runtime volume, using a holder container (the mechanism already
# documented in docs/DOCKER_PRODUCTION_TRANSITION.md, section 7 step A). This
# script never executes against production unless an operator explicitly
# substitutes the required placeholders/variables AND picks a run mode.
#
# Intended flow:
#
#   HOST .runtime
#       |
#       | one-time additive copy (host path never modified, never deleted)
#       v
#   Docker named volume
#       |
#       v
#   /app/.runtime   (mounted inside the writeback container)
#
# REQUIRED SUBSTITUTIONS (do not put real paths/credentials/PHI in this file;
# substitute them on the command line or via environment instead):
#
#   --source DIR      absolute path to the host .runtime directory
#   --volume NAME     the Docker named volume (compose resource "writeback_runtime";
#                     full name care1960-prognocis-writeback_writeback_runtime)
#   --image NAME      image used for the holder container (default:
#                     care1960-prognocis-writeback:latest)
#
# Alternatively export the placeholders below. The script FAILS CLOSED if the
# placeholder values are still present (un-substituted) or empty.
#
# SAFETY INVARIANTS (enforced):
#   - refuses to run unless --source and --volume are explicit non-empty values
#   - verifies the source directory exists and is non-empty
#   - never deletes, moves, or modifies the host source
#   - never runs `docker compose down -v`
#   - never runs `docker volume rm`
#   - never overwrites or deletes existing files in the target volume; if the
#     volume already holds files with the same relative paths, the script
#     FAILS CLOSED (additive copy only — there is deliberately no overwrite
#     flag; resolve the target side first)
#   - prints exactly what it intends to do BEFORE copying
#   - supports a dry-run mode (also the default when --execute is absent)
#
# RUN MODES:
#   --dry-run         print the plan and exit (default)
#   --execute         actually perform the copy (only with all guards satisfied)
#
# The host Hermes cron job (care1960-prognocis-clinical-drafts) MUST be paused
# by the operator during the real migration window; this script cannot pause it
# and does not attempt to.

default_source="__HOST_RUNTIME_PATH__"
default_volume="__DOCKER_RUNTIME_VOLUME__"
default_image="care1960-prognocis-writeback:latest"

source_dir="${MIGRATE_SOURCE_DIR:-$default_source}"
volume_name="${MIGRATE_VOLUME_NAME:-$default_volume}"
image_name="${MIGRATE_IMAGE:-$default_image}"
holder_name="wb-runtime-migrate"
mode="dry-run"

usage() {
  cat <<'EOF'
Usage: migrate-runtime-to-docker.template.sh [--source DIR] [--volume NAME]
       [--image NAME] [--dry-run | --execute] [-h]

TEMPLATE ONLY — safe one-time additive copy of the host .runtime directory
into the Docker named runtime volume. Fails closed unless the source and
volume are explicitly substituted.

  --source DIR    absolute path to the host .runtime directory (required)
  --volume NAME   Docker named volume, e.g.
                  care1960-prognocis-writeback_writeback_runtime (required)
  --image NAME    image for the holder container (default: care1960-...:latest)
  --dry-run       print the plan only (default)
  --execute       perform the copy after all guards pass
  -h, --help      show this help

Environment fallbacks: MIGRATE_SOURCE_DIR, MIGRATE_VOLUME_NAME, MIGRATE_IMAGE.

Never run `docker compose down -v` or `docker volume rm` for this migration:
the browser profile and verification proof would be destroyed.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) source_dir="${2:?}"; shift 2 ;;
    --volume) volume_name="${2:?}"; shift 2 ;;
    --image) image_name="${2:?}"; shift 2 ;;
    --dry-run) mode="dry-run"; shift ;;
    --execute) mode="execute"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# --- fail closed on missing/unsubstituted required variables ----------------
if [[ -z "$source_dir" || "$source_dir" == "__HOST_RUNTIME_PATH__" ]]; then
  echo "error: host .runtime source is not set. Substitute __HOST_RUNTIME_PATH__" >&2
  echo "       or pass --source <absolute path>." >&2
  exit 3
fi
if [[ -z "$volume_name" || "$volume_name" == "__DOCKER_RUNTIME_VOLUME__" ]]; then
  echo "error: Docker volume name is not set. Substitute __DOCKER_RUNTIME_VOLUME__" >&2
  echo "       or pass --volume <name>." >&2
  exit 3
fi

# --- verify the source directory ---------------------------------------------
if [[ ! -d "$source_dir" ]]; then
  echo "error: source directory does not exist: $source_dir" >&2
  exit 3
fi
source_entries="$(find "$source_dir" -mindepth 1 -maxdepth 1 | wc -l)"
if [[ "$source_entries" -eq 0 ]]; then
  echo "error: source directory is empty: $source_dir" >&2
  exit 3
fi
if [[ ! -r "$source_dir" ]]; then
  echo "error: source directory is not readable: $source_dir" >&2
  exit 3
fi

# --- verify the Docker preconditions ----------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "error: docker CLI not found" >&2
  exit 3
fi
if ! docker image inspect "$image_name" >/dev/null 2>&1; then
  echo "error: image not found: $image_name (run 'docker compose build' first)" >&2
  exit 3
fi
volume_exists="no"
if docker volume inspect "$volume_name" >/dev/null 2>&1; then
  volume_exists="yes"
fi

# --- refuse while a writeback container might be running ---------------------
running="$(docker ps --filter "ancestor=$image_name" --format '{{.Names}}' 2>/dev/null || true)"
if [[ -n "$running" ]]; then
  echo "error: a writeback container is running; refuse to migrate over a live job:" >&2
  echo "  $running" >&2
  echo "Pause the host cron job and wait for the run to finish first." >&2
  exit 3
fi

# --- compute the plan BEFORE any copy ----------------------------------------
cat <<EOF
Migration plan (mode: $mode)
  source : $source_dir  ($source_entries top-level entries, never modified/deleted)
  volume : $volume_name  (exists on host: $volume_exists)
  image  : $image_name
  holder : $holder_name (ad-hoc container, removed afterwards)
  target : /app/.runtime inside the volume
EOF

# Refuse to race the host runtime lock: the operator must have paused the cron
# job. We cannot verify the scheduler state here; the runbook (Phase C) owns it.
cat <<'EOF'
  preconditions that cannot be verified by this script (operator duty):
    - host Hermes cron job care1960-prognocis-clinical-drafts is PAUSED
    - no live writeback run is in progress
EOF

# Target contents today (may be empty for a fresh volume).
existing_files=()
if [[ "$volume_exists" == "yes" ]]; then
  while IFS= read -r f; do
    existing_files+=("$f")
  done < <(docker run --rm \
    -v "$volume_name:/app/.runtime" \
    "$image_name" \
    sh -c 'find /app/.runtime -type f 2>/dev/null | sed "s#^/app/.runtime/##"' || true)
fi

# Files that exist on BOTH sides: overwriting them is refused by default.
overlap=()
if [[ ${#existing_files[@]} -gt 0 ]]; then
  while IFS= read -r f; do
    rel="${f#./}"
    for e in "${existing_files[@]}"; do
      if [[ "$e" == "$rel" ]]; then
        overlap+=("$rel")
        break
      fi
    done
  done < <(cd "$source_dir" && find . -type f | sed 's#^\./##')
fi

if [[ ${#overlap[@]} -gt 0 ]]; then
  echo "  COULD OVERWRITE ${#overlap[@]} existing file(s) in the volume:"
  printf '    %s\n' "${overlap[@]}" | sed 's/^/    /'
  echo "  -> REFUSED in every mode (additive copy only; there is deliberately" >&2
  echo "     no overwrite flag). Resolve/clear the target side first — never" >&2
  echo "     'docker compose down -v', never 'docker volume rm'." >&2
  exit 3
fi

# --- dry-run: show exactly what would run, then stop --------------------------
if [[ "$mode" == "dry-run" ]]; then
  cat <<EOF
Dry-run — nothing was copied. The operator-substantiated copy would run:

  docker create --name "$holder_name" \\
    -v "$volume_name:/app/.runtime" \\
    "$image_name"
  docker cp "$source_dir/." "$holder_name:/app/.runtime/"
  docker rm -f "$holder_name"

After the copy, verify the volume (runbook PHASE C step 5):
  docker run --rm -v "$volume_name:/app/.runtime" \\
    "$image_name" sh -c 'find /app/.runtime -maxdepth 2'
EOF
  exit 0
fi

# --- execute mode --------------------------------------------------------------
if [[ "$mode" == "execute" ]]; then
  if [[ ${#overlap[@]} -gt 0 ]]; then
    echo "error: ${#overlap[@]} file(s) exist in the volume and would be" >&2
    echo "overwritten. Additive copy only: resolve the target side first" >&2
    echo "(never 'docker compose down -v', never 'docker volume rm')." >&2
    exit 3
  fi
  echo "Executing migration copy..."
  docker rm -f "$holder_name" >/dev/null 2>&1 || true
  docker create --name "$holder_name" \
    -v "$volume_name:/app/.runtime" \
    "$image_name" >/dev/null
  docker cp "$source_dir/." "$holder_name:/app/.runtime/"
  docker rm -f "$holder_name" >/dev/null
  echo "Copy complete. Host source untouched: $source_dir"
  echo "Verify the volume state (runbook PHASE C step 5):"
  docker run --rm \
    -v "$volume_name:/app/.runtime" \
    "$image_name" sh -c 'find /app/.runtime -maxdepth 2 | sort'
fi