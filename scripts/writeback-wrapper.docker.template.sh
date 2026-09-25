#!/usr/bin/env bash
set -euo pipefail
umask 077

# Docker batch wrapper TEMPLATE — NOT INSTALLED, NOT ACTIVE.
#
# This template is the planned Docker equivalent of writeback-wrapper.template.sh.
# It is intentionally NOT wired into Hermes yet. The production scheduler must
# keep running the host-based wrapper until the Docker path has been manually
# validated (see docs/DOCKER_PRODUCTION_TRANSITION.md, section "Manual
# validation checklist before any switch").
#
# Generated form (same sed pattern as the host wrapper installer):
#   sed -e "s|__PROJECT_ROOT__|<absolute host repo path>|g" \
#     scripts/writeback-wrapper.docker.template.sh > <wrapper>
#
# Invocation semantics preserved from the host wrapper:
#   host:     exec "$node_bin" src/cli.mjs run --config config/writeback.json
#   docker:   exec docker compose run --rm -T writeback
# Both exec the target so the scheduler receives the job's real exit code.
# -T: no pseudo-TTY allocation (cron delivers no interactive stdin).

project_root="__PROJECT_ROOT__"
cd -- "$project_root"

# Single-shot batch job; never `docker compose up -d`.
# The container exit code is the scheduler exit code:
#   docker compose run -> docker-entrypoint.sh -> node CLI exit code.
exec docker compose run --rm -T writeback