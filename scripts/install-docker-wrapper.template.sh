#!/usr/bin/env bash
set -euo pipefail
umask 077

# install-docker-wrapper.template.sh — TEMPLATE ONLY. NOT INSTALLED, NOT ACTIVE.
#
# This template GENERATES the Docker-based Hermes wrapper
# (care1960-prognocis-clinical-drafts.docker.sh) from
# scripts/writeback-wrapper.docker.template.sh, the same sed-substitution
# mechanism that scripts/install-hermes-cron.sh uses for the host wrapper.
#
# "As safe as possible by default":
#   - it never modifies ~/.hermes and never registers/edits Hermes cron jobs;
#     that is a documented, operator-run manual step (runbook PHASE G)
#   - it defaults to dry-run and only WRITES to a local staging path when the
#     --generate flag is passed
#   - it prints the exact command the operator must run by hand at switch time
#     to install the generated wrapper under Hermes
#
# INTENDED EVENTUAL USE (documented, NOT performed by this template):
#   sed -e "s|__PROJECT_ROOT__|/path/to/project|g" \
#       scripts/writeback-wrapper.docker.template.sh \
#       > "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
#   chmod 700 "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
#
# The generated wrapper's last line is `exec docker compose run --rm -T writeback`,
# so the container exit code propagates to Hermes, matching the current
# host-wrapper behavior.

default_project_root="__PROJECT_ROOT__"
staging_dir="scripts/_generated"
wrapper_name="care1960-prognocis-clinical-drafts.docker.sh"
hermes_scripts_dir="${HERMES_HOME:-$HOME/.hermes}/scripts"

project_root="${MIGRATE_PROJECT_ROOT:-$default_project_root}"
action="dry-run"

usage() {
  cat <<'EOF'
Usage: install-docker-wrapper.template.sh [--project-root DIR]
       [--generate | --dry-run] [-h]

TEMPLATE ONLY — generates the Docker-based Hermes wrapper from
scripts/writeback-wrapper.docker.template.sh into a LOCAL staging path.
It never writes into ~/.hermes and never touches Hermes cron jobs.

  --project-root DIR  absolute path to the project root (required in --generate)
  --generate          write the wrapper to "$staging_dir/$wrapper_name"
  --dry-run           print the command that would run (default)
  -h, --help          show this help

The operator performs the actual Hermes switch manually (runbook PHASE G):
  sed -e "s|__PROJECT_ROOT__|$project_root|g" scripts/writeback-wrapper.docker.template.sh \
      > "$hermes_scripts_dir/care1960-prognocis-clinical-drafts.sh" \
  && chmod 700 "$hermes_scripts_dir/care1960-prognocis-clinical-drafts.sh"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-root) project_root="${2:?}"; shift 2 ;;
    --generate) action="generate"; shift ;;
    --dry-run) action="dry-run"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

# --- fail closed on missing/unsubstituted project root ------------------------
if [[ -z "$project_root" || "$project_root" == "__PROJECT_ROOT__" ]]; then
  echo "error: project root is not set. Substitute __PROJECT_ROOT__ or pass" >&2
  echo "       --project-root <absolute path>." >&2
  exit 3
fi
if [[ ! -d "$project_root" ]]; then
  echo "error: project root directory does not exist: $project_root" >&2
  exit 3
fi

template_file="$project_root/scripts/writeback-wrapper.docker.template.sh"
if [[ ! -r "$template_file" ]]; then
  echo "error: wrapper template not found: $template_file" >&2
  exit 3
fi

# --- hard rule: this template NEVER writes into Hermes -------------------------
if [[ "$staging_dir" == "$hermes_scripts_dir"* ]] \
 || [[ "$staging_dir" == "$HOME/.hermes"* ]]; then
  echo "error: refusing to write into Hermes ($hermes_scripts_dir)." >&2
  echo "The Hermes switch is a manual operator step (runbook PHASE G);" >&2
  echo "this template only stages the wrapper locally." >&2
  exit 3
fi

# --- show the intended switch command (dry-run is the default) -----------------
cat <<EOF
Wrapper generation plan (mode: $action)
  template   : $template_file
  project    : $project_root
  local out  : $staging_dir/$wrapper_name
  hermes out : $hermes_scripts_dir/care1960-prognocis-clinical-drafts.sh (NOT touched)
EOF

if [[ "$action" == "dry-run" ]]; then
  cat <<EOF
Dry-run. To stage the wrapper locally without touching Hermes, run this template
again with --generate (still writes only to $staging_dir).

At switch time the operator runs BY HAND (runbook PHASE G) the exact command in
the usage text above to place the wrapper into Hermes and chmod 700 it.
EOF
  exit 0
fi

# --- generate to the local staging path only -----------------------------------
mkdir -p "$staging_dir"
out_file="$staging_dir/$wrapper_name"
sed -e "s|__PROJECT_ROOT__|$project_root|g" \
    "$template_file" > "$out_file"
chmod 700 "$out_file"

# Verify the generated wrapper propagates the container exit code (runbook A,
# section "image/runtime validation checklist", wrapper contract).
if ! grep -q 'exec docker compose run --rm -T writeback' "$out_file"; then
  echo "error: generated wrapper does not end in the expected exec command;" >&2
  echo "refusing to present it as usable. Inspect: $out_file" >&2
  exit 3
fi

echo "Staged local wrapper (NOT installed into Hermes):"
echo "  $out_file"
echo "Operator must run the PHASE G manual command (usage text) to switch Hermes."