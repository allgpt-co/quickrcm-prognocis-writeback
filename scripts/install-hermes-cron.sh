#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dry_run=false
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: $0 [--dry-run] [cron-expression] [delivery-target]"
  exit 0
fi
if [[ "${1:-}" == "--dry-run" ]]; then
  dry_run=true
  shift
fi
schedule="${1:-15 0-20,23 * * *}"
delivery="${2:-local}"
job_name="quickrcm-prognocis-clinical-drafts"

node_bin="$(command -v node || true)"
if [[ -z "$node_bin" ]]; then
  echo "Node.js was not found." >&2
  exit 69
fi
if command -v hermes >/dev/null 2>&1; then
  hermes_command=("$(command -v hermes)")
elif [[ -r "$project_root/../hermes_agent/hermes_agent/hermes" ]] \
  && command -v python3 >/dev/null 2>&1; then
  hermes_command=("$(command -v python3)" "$project_root/../hermes_agent/hermes_agent/hermes")
else
  echo "Hermes CLI was not found." >&2
  exit 69
fi

hermes_base="${HERMES_HOME:-${HOME}/.hermes}"
scripts_dir="$hermes_base/scripts"
wrapper="$scripts_dir/quickrcm-prognocis-clinical-drafts.sh"
if [[ "$dry_run" == true ]]; then
  echo "Hermes command: ${hermes_command[*]}"
  echo "Wrapper target: $wrapper"
  echo "Job: $job_name"
  echo "Schedule: $schedule"
  echo "Delivery: $delivery"
  exit 0
fi

if [[ ! -r "$project_root/config/writeback.json" ]]; then
  echo "Create and validate config/writeback.json before installing the cron job." >&2
  exit 78
fi
if ! "$node_bin" "$project_root/src/cli.mjs" validate-config \
  --config "$project_root/config/writeback.json"; then
  echo "Cron installation stopped because the live write-back configuration is not ready." >&2
  exit 78
fi
mkdir -p -- "$scripts_dir"
chmod 700 -- "$scripts_dir"
sed -e "s|__PROJECT_ROOT__|$project_root|g" -e "s|__NODE_BIN__|$node_bin|g" \
  "$project_root/scripts/writeback-wrapper.template.sh" > "$wrapper"
chmod 700 -- "$wrapper"

if "${hermes_command[@]}" cron edit "$job_name" \
  --schedule "$schedule" \
  --script "quickrcm-prognocis-clinical-drafts.sh" \
  --deliver "$delivery" \
  --workdir "$project_root" \
  --no-agent >/dev/null 2>&1; then
  echo "Updated Hermes cron job: $job_name"
else
  "${hermes_command[@]}" cron create "$schedule" \
    --no-agent \
    --script "quickrcm-prognocis-clinical-drafts.sh" \
    --deliver "$delivery" \
    --workdir "$project_root" \
    --name "$job_name"
fi
"${hermes_command[@]}" cron status
echo "Installed draft-only QuickRCM-to-PrognoCIS polling. This job never signs or closes encounters."
