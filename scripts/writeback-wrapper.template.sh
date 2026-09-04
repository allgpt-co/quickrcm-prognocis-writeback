#!/usr/bin/env bash
set -euo pipefail
umask 077

project_root="__PROJECT_ROOT__"
node_bin="__NODE_BIN__"
cd -- "$project_root"
exec "$node_bin" src/cli.mjs run --config config/writeback.json

