#!/bin/sh
#
# docker-entrypoint.sh — production container startup for
# quickrcm-prognocis-writeback (Care1960 -> PrognoCIS clinical draft writer).
#
# Responsibilities
#   1. Resolve the Playwright-installed Chromium binary.
#   2. Launch headless Chromium with CDP on 127.0.0.1:9223 (loopback only),
#      using the repository's documented user-data directory
#      (.runtime/shared-clinical-browser-profile) so authenticated sessions
#      persist across restarts when .runtime is a mounted volume.
#   3. Wait until the CDP HTTP endpoint is ready (bounded poll, no fixed
#      sleep): the application attaches with chromium.connectOverCDP() and
#      serves stale-login cleanup through /json/list and /json/close/<id>.
#   4. Run the Node CLI (Docker CMD / user overrides) as a direct child.
#   5. Propagate the CLI exit code and shut Chromium down cleanly on exit,
#      including SIGTERM/SIGINT forwarding from the container runtime
#      (docker stop). Single-shot batch worker: the CLI is never restarted.
#
# Environment (all optional)
#   CDP_HOST             CDP bind address (default 127.0.0.1)
#   CDP_PORT             CDP port (default 9223)
#   CDP_READY_TIMEOUT    seconds to wait for CDP readiness (default 60)
#   PROJECT_ROOT         runtime root (default /app — the image WORKDIR)
#   BROWSER_USER_DATA_DIR  Chromium profile directory (default:
#                       $PROJECT_ROOT/.runtime/shared-clinical-browser-profile)
#   CHROMIUM_EXECUTABLE  explicit Chromium binary override
#
# Strictly POSIX sh; no bashisms. No credentials live here — runtime secrets
# arrive as environment variables and mounted files, never in this script or
# the image.
set -eu
umask 077

# --- defaults ---------------------------------------------------------------
PROJECT_ROOT="${PROJECT_ROOT:-/app}"
CDP_HOST="${CDP_HOST:-127.0.0.1}"
CDP_PORT="${CDP_PORT:-9223}"
CDP_READY_TIMEOUT="${CDP_READY_TIMEOUT:-60}"
CDP_URL="http://${CDP_HOST}:${CDP_PORT}"
USER_DATA_DIR="${BROWSER_USER_DATA_DIR:-${PROJECT_ROOT}/.runtime/shared-clinical-browser-profile}"

CHROMIUM_BIN=""
CHROMIUM_PID=""
CLI_PID=""
START_CHROMIUM=0

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "docker-entrypoint: node not found in PATH" >&2
  exit 1
fi

# --- helpers ----------------------------------------------------------------

# Select the Chromium binary: explicit override, else ask Playwright (it knows
# the exact revision installed under PLAYWRIGHT_BROWSERS_PATH), else scan the
# standard Playwright browser roots.
resolve_chromium() {
  if [ -n "${CHROMIUM_EXECUTABLE:-}" ]; then
    if [ -x "$CHROMIUM_EXECUTABLE" ]; then
      CHROMIUM_BIN="$CHROMIUM_EXECUTABLE"
      return 0
    fi
    echo "docker-entrypoint: CHROMIUM_EXECUTABLE is not executable: $CHROMIUM_EXECUTABLE" >&2
    return 1
  fi

  candidate="$(
    cd "$PROJECT_ROOT" 2>/dev/null && "$NODE_BIN" --input-type=module -e \
      "import { chromium } from 'playwright'; process.stdout.write(chromium.executablePath())" 2>/dev/null || true
  )"
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    CHROMIUM_BIN="$candidate"
    return 0
  fi

  for root in /ms-playwright /opt/ms-playwright; do
    for candidate in "$root"/chromium-*/chrome-linux64/chrome; do
      if [ -x "$candidate" ]; then
        CHROMIUM_BIN="$candidate"
        return 0
      fi
    done
  done

  echo "docker-entrypoint: Playwright Chromium not found (checked /ms-playwright and /opt/ms-playwright)" >&2
  return 1
}

# Bounded poll of the CDP HTTP endpoint. Fails fast if Chromium dies before
# becoming ready; never a fixed-length sleep.
wait_for_cdp() {
  deadline=$(( $(date +%s) + CDP_READY_TIMEOUT ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$NODE_BIN" -e \
      "fetch('${CDP_URL}/json/version').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
      echo "docker-entrypoint: Chromium exited before CDP became ready" >&2
      return 1
    fi
    sleep 1
  done
  echo "docker-entrypoint: timed out after ${CDP_READY_TIMEOUT}s waiting for CDP at ${CDP_URL}" >&2
  return 1
}

# Terminate Chromium: SIGTERM, a short grace period, then SIGKILL. Idempotent.
stop_chromium() {
  if [ -z "$CHROMIUM_PID" ]; then
    return 0
  fi
  if kill -0 "$CHROMIUM_PID" 2>/dev/null; then
    echo "docker-entrypoint: stopping Chromium (pid $CHROMIUM_PID)" >&2
    kill -TERM "$CHROMIUM_PID" 2>/dev/null || true
    i=0
    while [ "$i" -lt 10 ]; do
      if ! kill -0 "$CHROMIUM_PID" 2>/dev/null; then
        break
      fi
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "$CHROMIUM_PID" 2>/dev/null; then
      echo "docker-entrypoint: Chromium did not exit on SIGTERM; sending SIGKILL" >&2
      kill -KILL "$CHROMIUM_PID" 2>/dev/null || true
    fi
  fi
  # Reap the background job so this shell (PID 1) leaves no zombies.
  wait "$CHROMIUM_PID" 2>/dev/null || true
  CHROMIUM_PID=""
}

# Forward container stop signals to the CLI and Chromium so the run lock is
# released and the browser profile closes cleanly.
forward_signal() {
  if [ -n "$CLI_PID" ]; then
    kill -TERM "$CLI_PID" 2>/dev/null || true
  fi
  if [ -n "$CHROMIUM_PID" ]; then
    kill -TERM "$CHROMIUM_PID" 2>/dev/null || true
  fi
}

trap forward_signal TERM INT
trap 'stop_chromium' EXIT

# --- resolve the command ----------------------------------------------------
# Docker CMD (or a full override) arrives as $@. Recognized forms:
#   (no args)                                    -> probe (the CMD default)
#   node src/cli.mjs [args]                      -> explicit CLI invocation
#   run|probe|validate-config|validate-response  -> prepend node src/cli.mjs
#   -flag / --flag ...                           -> prepend node src/cli.mjs
#   anything else                                -> passthrough (debug/shell);
#                                                   no Chromium is started
if [ "$#" -eq 0 ]; then
  set -- "$NODE_BIN" src/cli.mjs
  START_CHROMIUM=1
else
  case "$1" in
    node|nodejs|*/node|*/nodejs)
      # Decide from the ORIGINAL arguments before rebuilding: the writeback
      # CLI has a script path ending in src/cli.mjs as its second argument.
      script="${2:-}"
      if [ "$script" = "src/cli.mjs" ] || [ "$script" = "$PROJECT_ROOT/src/cli.mjs" ]; then
        START_CHROMIUM=1
      fi
      shift
      set -- "$NODE_BIN" "$@"
      ;;
    run|probe|validate-config|validate-response|-*|--*)
      set -- "$NODE_BIN" src/cli.mjs "$@"
      START_CHROMIUM=1
      ;;
    *)
      # Passthrough command (e.g. `docker run image sh -c '...'`).
      ;;
  esac
fi

# --- startup: Chromium + CDP -------------------------------------------------
if [ "$START_CHROMIUM" -eq 1 ]; then
  if ! resolve_chromium; then
    exit 1
  fi
  echo "docker-entrypoint: using Chromium at $CHROMIUM_BIN"

  # The profile is the application's documented user-data directory; it must
  # exist and be writable by the non-root runtime user before Chromium starts.
  if ! mkdir -p "$USER_DATA_DIR"; then
    echo "docker-entrypoint: cannot create browser profile directory: $USER_DATA_DIR" >&2
    exit 1
  fi
  chmod 700 "$USER_DATA_DIR"

  # Launch headless Chromium with CDP on the loopback interface only:
  #   --headless=new                    headless browser (the app's config
  #                                     headless flag only applies to
  #                                     self-launch mode, which is unused here)
  #   --no-sandbox                      non-root user; matches Playwright's
  #                                     chromiumSandbox=false default
  #   --remote-debugging-address=127.0.0.1  CDP bound to loopback only
  #   --remote-debugging-port=9223      the app's browser.cdpEndpoint
  #   --remote-allow-origins=*          Chromium >=111 rejects CDP WebSocket
  #                                     origins not listed here; Playwright
  #                                     connectOverCDP needs this. Loopback
  #                                     bound, so no external exposure.
  #   --user-data-dir                   persistent profile; login sessions
  #                                     survive restarts on a mounted .runtime
  #   --window-size=1440,1000           preserve the app's viewport assumption
  #   --disable-dev-shm-usage           /dev/shm is small in containers; avoid
  #                                     the classic Chromium crash
  #   --no-first-run --no-default-browser-check  skip fresh-profile first-run UI
  #   about:blank                       open a default page so
  #                                     browser.contexts()[0] exists for
  #                                     connectOverCDP
  "$CHROMIUM_BIN" \
    --headless=new \
    --no-sandbox \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="$CDP_PORT" \
    '--remote-allow-origins=*' \
    --user-data-dir="$USER_DATA_DIR" \
    --window-size=1440,1000 \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    about:blank \
    >/dev/null 2>&1 &
  CHROMIUM_PID=$!

  echo "docker-entrypoint: waiting for CDP on ${CDP_URL} (Chromium pid $CHROMIUM_PID, timeout ${CDP_READY_TIMEOUT}s)"
  if ! wait_for_cdp; then
    stop_chromium
    exit 1
  fi
  echo "docker-entrypoint: CDP ready on ${CDP_URL}"
fi

echo "docker-entrypoint: running: $*"

# --- passthrough path (no Chromium) ------------------------------------------
if [ "$START_CHROMIUM" -eq 0 ]; then
  exec "$@"
fi

# --- CLI path: run as a direct child, propagate its exit code -----------------
set +e
"$@" &
CLI_PID=$!
while :; do
  wait "$CLI_PID"
  cli_status=$?
  # If wait was interrupted by a signal trap while the CLI is still running,
  # keep waiting for its eventual exit status.
  if kill -0 "$CLI_PID" 2>/dev/null; then
    continue
  fi
  break
done
set -e

echo "docker-entrypoint: Node CLI exited with status $cli_status"
stop_chromium
exit "$cli_status"