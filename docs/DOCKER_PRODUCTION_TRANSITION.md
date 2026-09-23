# Docker production transition (design only — not activated)

> **Status: PLANNED. Nothing in this document is active.**
> The production scheduler still runs the host-based wrapper
> (`${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh`
> generated from `scripts/writeback-wrapper.template.sh`). The Docker path must be
> manually validated before any switch; see [section 6](#6-manual-validation-checklist-before-any-switch).
>
> **Phase 7 operator package:** the step-by-step migration procedure lives in
> [docs/DOCKER_MIGRATION_RUNBOOK.md](DOCKER_MIGRATION_RUNBOOK.md) (PHASES A–I,
> docker access precheck, image/runtime validation checklist). Safety templates:
> `scripts/migrate-runtime-to-docker.template.sh` (one-time additive `.runtime`
> → named volume copy, fail-closed, dry-run default) and
> `scripts/install-docker-wrapper.template.sh` (Docker wrapper generation
> template — never writes into Hermes). All three are NOT ACTIVE.

## 1. Current production deployment (as-is)

```text
Hermes cron (15 0-20,23 * * *, job care1960-prognocis-clinical-drafts)
  -> ~/.hermes/scripts/care1960-prognocis-clinical-drafts.sh   (generated wrapper)
  -> exec "$node_bin" src/cli.mjs run --config config/writeback.json
  -> CLI: dotenv(PROJECT_ROOT/.env) -> load config/writeback.json
  -> acquireRunLock(.runtime/writeback.lock, O_EXCL, 6h stale)
  -> attach to host Chrome via CDP http://127.0.0.1:9223 (loginPerRun=false)
  -> writeback -> audit/ledger in .runtime -> exit code -> Hermes
```

Installer: `scripts/install-hermes-cron.sh` (validates node + hermes + config,
exits 69/78 on missing prerequisites, `umask 077`, generates the wrapper via
sed substitution of `__PROJECT_ROOT__`/`__NODE_BIN__`, registers the Hermes
job with `--deliver local --workdir <root> --no-agent`).

## 2. Proposed Dockerized deployment (target — not active)

```text
Hermes cron (same job, schedule unchanged)
  -> scripts/writeback-wrapper.docker.template.sh (generated, sed __PROJECT_ROOT__)
  -> exec docker compose run --rm -T writeback
  -> docker-entrypoint.sh: start container Chromium (CDP 127.0.0.1:9223 INSIDE)
  -> CLI (in-image node): dotenv(/app/.env absent-> env_file already injected)
  -> load config/writeback.json (read-only mount)
  -> acquireRunLock(/app/.runtime/writeback.lock in shared named volume)
  -> attach to the container's Chromium -> writeback -> audit/ledger in volume
  -> exit code: CLI -> entrypoint (stops Chromium) -> container -> compose -> exec -> Hermes
```

Environment (`env_file: .env`) and `config/` are supplied at run time; they
never enter the image. `.runtime/` lives in the `writeback_runtime` named volume.

## 3. How the current scheduler invokes the app — investigation answers

1. **How is the app currently invoked/scheduled?**
   One Hermes cron job, `care1960-prognocis-clinical-drafts`, default schedule
   `15 0-20,23 * * *` (minute 15, hours 0–20 and 23), delivery `local`.
   Installed by `scripts/install-hermes-cron.sh`.

2. **Does the existing wrapper directly invoke the CLI or wrap other logic?**
   Thin `exec` shim only. Generated body:
   `cd -- "$project_root"; exec "$node_bin" src/cli.mjs run --config config/writeback.json`.
   No pid guard, no log wrapper, no retry. `exec` means the scheduler receives
   the CLI's real exit code, and Hermes captures the CLI's stdout/stderr.

3. **What env/config/runtime dependencies exist?**
   - Env (dotenv from `PROJECT_ROOT/.env`, names from `src/runtime/config.mjs`):
     `SUPABASE_ANON_KEY`, `SUPABASE_TENANT_API_KEY`, `prognosis_username`,
     `prognosis_password`, `CLINICAL_WRITE_ACK`.
   - Config: `config/writeback.json` (structural validation gates `run`).
   - Runtime (all resolved under `PROJECT_ROOT`): `.runtime/writeback.lock`,
     `.runtime/writeback-audit.jsonl`, `.runtime/verified-drafts.jsonl`,
     `.runtime/shared-clinical-browser-profile`, plus request/response files.
   - A live Chromium/CDP endpoint (`browser.cdpEndpoint`, localhost-only by
     validation) unless `loginPerRun=true` with credentials.

4. **Can `docker compose run --rm` replace the host node invocation cleanly?**
   Yes. The container runs the same CLI (`run --config config/writeback.json`
   is the compose `command`), with the same env (env_file), the same config
   (read-only mount), and the same relative runtime paths (all resolve under
   `PROJECT_ROOT=/app`, and `/app/.runtime` is the persistent volume). The
   only behavioral difference is that Chromium is launched by the entrypoint
   inside the container instead of running persistently on the host.

5. **Does containerized Chromium conflict with the host Chrome/CDP session?**
   No direct conflict. The container binds CDP on its own loopback
   (`0100007F:2407`); no container port is published, so the host's CDP
   listener on `127.0.0.1:9223` is untouched. They remain two separate browser
   processes with separate profiles (host `.runtime` directory vs volume
   copy). Until login state is migrated, the volume profile is unauthenticated —
   see issue [10.1](#10-issues-that-must-be-resolved-before-real-production-deployment).

6. **How is existing host `.runtime` data migrated to the volume?**
   One-time additive copy using the existing image (exact commands in
   [section 7](#7-exact-migration-commands-for-the-approved-transition-day-do-not-run-now)).
   The host `.runtime` is left in place as the rollback source. **Not executed
   in this phase.**

7. **How do persistent volumes behave across `docker compose run` jobs?**
   `docker compose run --rm` creates a disposable container per job; the named
   volume survives and carries lock/audit/ledger/profile between jobs —
   equivalent to the host `.runtime`. `docker compose down` keeps the volume;
   `down -v` deletes it (browser profile + verification proof destroyed).

8. **Do exit codes reach the scheduler?**
   Yes, unchanged. Verified Phase 4: a failing CLI propagates exit 1 through
   the entrypoint (which also stops Chromium) to `docker compose run`. The
   docker wrapper uses `exec docker compose run --rm -T writeback`, so the
   shell adds nothing and Hermes sees the CLI's code (0 = success or
   partial-with-failures=0; 1 = errors/failures outstanding).

9. **How is concurrency prevented?**
   By the existing application lock (`src/runtime/lock.mjs`): atomic
   `O_EXCL` create of `.runtime/writeback.lock` (`{pid, startedAt}`), 6-hour
   stale window, `RUN_ALREADY_ACTIVE` error -> exit 1. Because the lock lives
   in the shared named volume, every Docker job contends on the same file —
   concurrent `docker compose run --rm writeback` jobs are impossible; the
   loser exits 1 with the lock message. **No second locking system is added.**
   Remaining caveat: a hard-killed job (`docker kill -9` / host crash) leaves a
   fresh lock that blocks reruns for up to 6 hours (same behavior as today).

10. **Where do job logs go?**
    Same place as today. Hermes (`--deliver local`) captures the wrapper's
    stdout/stderr; `docker compose run --rm -T` streams the container's
    stdout/stderr there (CLI JSON summary + entrypoint messages). For
    post-hoc inspection: `docker compose ps -a` (recent job status) and
    `docker compose logs writeback` (retained logs of recent run containers —
    the disposable runs themselves are removed per `--rm`).

## 4. What changes vs what stays identical

| Aspect | Stays identical | Changes |
|---|---|---|
| Source/config semantics | `config/writeback.json`, `--config`, relative-paths-under-project-root | — |
| Env mechanism | `.env` supplies the same 5 variables at run time | injection moves from dotenv to `env_file` |
| Write/verification logic | whole `src/` + CLI | — |
| Run lock | `acquireRunLock` on `.runtime/writeback.lock` | lock host path -> `writeback_runtime` volume path |
| Exit codes | 0/1 semantics | now transit entrypoint -> container -> compose |
| Browser | Chromium + CDP on localhost:9223 | long-lived host Chrome -> per-job container Chromium |
| Scheduler | same Hermes job + schedule | generated wrapper content (template only) |

## 5. Files changed this phase

- `scripts/writeback-wrapper.docker.template.sh` — **new**; template only, not
  installed, not referenced by any scheduler. Uses the same sed-substitution
  pattern as the existing wrapper template.
- `docs/DOCKER_PRODUCTION_TRANSITION.md` — **new**; this document.
- `README.md` — Docker section updated: transition pointer (this doc) and a
  scheduler-gating reminder.
- `docs/PRODUCTION_SECOND_CRON.md` — pointer to this doc; no runbook changes.
- Unchanged: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`,
  `src/`, `package.json`, `scripts/install-hermes-cron.sh`,
  `scripts/writeback-wrapper.template.sh`, `.env` (absent), active config
  (absent). The host deployment, its wrapper, and the Hermes job are intact.

## 6. Manual validation checklist before any switch

Every gate must pass before the scheduler wrapper is replaced:

1. Build and run the image (`docker compose build`; smoke `docker compose run --rm -T writeback`
   without active config -> clean exit 1, Chromium stopped).
2. Create throwaway `.env` from `.env.example` only; confirm `docker compose config` resolves.
3. Run `node src/cli.mjs validate-config --config config/writeback.json` (unchanged host gate,
   and optionally `docker compose run --rm -T writeback validate-config`).
4. Migrate `.runtime` into the volume (section 7, step A) while the host cron
   job is **paused**, then confirm lock/audit/ledger/profile appear in the volume.
5. Confirm the PrognoCIS login session is usable in the **container** profile
   (issue 10.1) — either migrated session or a supervised `loginPerRun` login.
6. Run a supervised probe: `docker compose run --rm -T writeback probe --max-records 1`
   (writes disabled) and review the PHI-free audit.
7. Run a supervised draft canary `--max-records 1` with approval gates; verify
   HPI/ROS/PE read-back, draft status, exit code, audit/ledger updates.
8. Verify repeated canary creates no additional writes (ledger repeat detection).
9. Confirm no host port is published (`docker ps` PORTS column empty during a run).
10. Only then: announce, switch the wrapper (section 7, step B), watch ≥1
    scheduled tick, and keep rollback ready (section 8).

## 7. Exact migration commands (for the approved transition day — do NOT run now)

A. One-time additive `.runtime` copy into the volume (host cron paused first;
   `docker cp` into an ad-hoc holder container; the volume is not mounted
   read-only so files arrive with the image user's ownership):

```bash
docker create --name wb-runtime-migrate \
  -v care1960-prognocis-writeback_writeback_runtime:/app/.runtime \
  care1960-prognocis-writeback:latest
docker cp "$PWD/.runtime/." wb-runtime-migrate:/app/.runtime/
docker rm wb-runtime-migrate
```

B. Switch the scheduler wrapper to the Docker template (generated locally; the
   Hermes job keeps its name/schedule; swap only what the job executes):

```bash
sed -e "s|__PROJECT_ROOT__|$PWD|g" \
  scripts/writeback-wrapper.docker.template.sh \
  > "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
chmod 700 "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
# Validate by running the generated wrapper once manually (no credentials).
```

C. Verify after the first scheduled tick: exit code 0 and audit/ledger rows in
   the volume; `docker compose ps -a` shows the finished run.

## 8. Rollback

- Restore the host wrapper in place of the Docker one:
  `bash scripts/install-hermes-cron.sh` (regenerates the host wrapper and
  re-registers the job — the installer is unchanged).
- Host `.runtime` retains pre-migration state (the copy is additive and the
  host path is never touched by Docker jobs).
- To remove Docker state entirely without data loss:
  `docker compose down` (keeps the named volume). `docker compose down -v`
  also deletes the volume — browser profile and local verification proof are
  then gone and must be recreated.

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Container profile starts unauthenticated; first real run may fail login | High | Migrate `.runtime` session or supervised login (10.1) |
| Running host and Docker paths concurrently could double-process the same page | High | App lock prevents simultaneous **runs** (same volume); pause host cron during validation; switch exactly once |
| Hard-killed job leaves fresh lock, blocking retries up to 6h (existing behavior; Phase 6 confirmed `src/cli.mjs` has NO signal handlers, so even a graceful `docker compose stop` mid-run leaves the lock fresh — see 12.2) | Medium | Wait out the 6h stale window, or remove the lock per the 12.2 procedure after confirming no live run; host and Docker behave identically |
| `docker compose config` fails if `.env` is missing (env_file resolution) | Medium | `.env` is required and present in production; smoke-test before wrapper switch |
| Cron user needs docker daemon + compose permission | Medium | Verify `docker compose run --rm -T writeback` manually under the same user |
| Docker daemon/downtime at scheduled time | Low–Medium | Same job remains registered; failure surfaces in Hermes logs; rollback is one installer run |
| Volume growth (profile + audit/ledger) | Low | json-file log rotation capped (10m x 3); volume is the documented persistent store |
| env-name drift in older docs (10.4) | Low | Apply the correct env names; doc note |

## 10. Issues that must be resolved before real production deployment

1. **Live PrognoCIS login must be created or migrated into the volume
   profile.** The container profile starts empty/`localhost` unless the
   `.runtime` copy carries the authenticated session; verify end-to-end with a
   probe before any write. The container has **no VNC/noVNC surface** (Phase 6
   grep: no vnc/novnc/5900-5901 in `Dockerfile`, `docker-entrypoint.sh`, or
   `docker-compose.yml`), so the CLI's "open Chrome through noVNC" hint is
   host-era guidance and does not exist in the container. Only two login paths
   exist in Docker: (a) migrate an authenticated host `.runtime` profile
   (section 7 step A), or (b) `loginPerRun=true` headless auto-login — which
   cannot complete MFA challenges, so it only works if the login requires no
   MFA or the volume profile session is already valid. See
   [section 3, item 5](#3-how-the-current-scheduler-invokes-the-app--investigation-answers)
   and [12.1](#12-phase-6-pre-production-readiness-review).
2. **A 6-hour stale-lock policy is needed.** `docker kill -9` or host crash
   leaves `.runtime/writeback.lock` fresh for 6h. Phase 6 verified the CLI
   registers no signal handlers, so a graceful stop mid-run behaves the same.
   Decided procedure (see 12.2 and the pre-production checklist): after
   confirming no live run, either wait out the 6h window or remove
   `/app/.runtime/writeback.lock` from the volume directly (command in 12.2).
3. **Cron user must be granted docker access**, and the switched wrapper must
   be re-validated under that user.
4. **Stale env names in older docs — RESOLVED in Phase 6.** Older docs used
   `CARE1960_API_KEY` / `CARE1960_BEARER_TOKEN` / `PROGNOCIS_USERNAME` /
   `PROGNOCIS_PASSWORD`, while the code (`src/runtime/config.mjs:10-18`) and
   `.env.example` use `SUPABASE_ANON_KEY` / `SUPABASE_TENANT_API_KEY` /
   `prognosis_username` / `prognosis_password`. Phase 6 corrected `README.md`,
   `docs/PRODUCTION_SECOND_CRON.md`, `docs/CARE1960_INTEGRATION.md`, and
   `docs/CARE1960_API_REQUIREMENTS.md`. `response.md` is a captured transcript
   artifact and was intentionally left unchanged. The code names are the single
   source of truth; see [12.4](#12-phase-6-pre-production-readiness-review).
5. **Volume state is the new single source of truth for `.runtime`.** Confirm
   backup/audit expectations for the profile + ledger after the switch.

## 11. Phase 5 test results

All tests executed locally (Windows host, Docker Desktop + WSL Ubuntu 26.04 for
the Linux-host wrapper execution). No commit, push, deploy, or scheduler change
was made.

| Test | Command | Result |
|---|---|---|
| A. Suite gate | in-image `npm run check` (Phase 4 build) | ✓ 82/82 passed in the image build gate (cached layer re-verified during C) |
| B. Compose config | `docker compose config` (throwaway `.env` from `.env.example`) | ✓ resolves; env 5 vars injected, `read_only`, tmpfs uid/gid, `restart: 'no'`, mem 2g, pids 512, no ports, volume declared |
| C. Build | `docker compose build` | ✓ exit 0; image `care1960-prognocis-writeback:latest` rebuilt from cache |
| D. Smoke | `docker compose run --rm -T writeback` (no active config) | ✓ Chromium started → CDP ready on 127.0.0.1:9223 (container) → CLI ran → "Configuration not found" clean failure → Chromium stopped → **exit 1 propagated** |
| E. Wrapper | generated Docker wrapper (`__PROJECT_ROOT__` → WSL path), no credentials | ✓ full chain via WSL: chromium → CDP → CLI → clean failure → chromium stopped → **numeric exit 1** (`WRAPPER_EXIT:1`) |
| F. No host port | `docker ps` mid-job PORTS | ✓ writeback container PORTS column **empty** at t=2/4/6s; only unrelated `rcm-postgres-test` publishes (0.0.0.0:5432) |
| G. Secrets | `.env` absent after tests | ✓ throwaway `.env` removed; `git ls-files` shows no `.env`; `.env.example` tracked and untouched |
| H. Config | active `config/writeback.json` | ✓ absent (`Test-Path` false; not in `git ls-files`) |
| I. Git | `git status --porcelain` | ✓ M README.md, M docs/PRODUCTION_SECOND_CRON.md; ?? docs/DOCKER_PRODUCTION_TRANSITION.md, scripts/writeback-wrapper.docker.template.sh (+ existing Phase 3/4 untracked Docker files) |
| J. Diff | `git diff --stat` | ✓ README.md +54, docs/PRODUCTION_SECOND_CRON.md +9 (63 additions, 0 deletions) |
| K. Transition | this document, sections 1–11 | ✓ completed |

Phase 5 artifacts (deliverables): current flow → section 1; proposed flow →
section 2; investigation answers → section 3; files changed → section 5;
migration commands → section 7; risks → section 9; rollback → section 8;
verification → this section; pre-production issues → section 10.

## 12. Phase 6 pre-production readiness review

Phase 6 was read-only verification of the dockerization design and migration
safety. **Nothing here activates the Docker path.** All changes in this phase
are documentation-only. Findings:

### 12.1 Authentication readiness (container)

Container has **no VNC/noVNC surface** (verified: no vnc/novnc/5900/5901 in
`Dockerfile`, `docker-entrypoint.sh`, or `docker-compose.yml`). The
`AUTH_REQUIRED` hint in `src/cli.mjs` that says "Open the remote Chrome through
noVNC" is host-era guidance and does not apply inside the container. Only two
login paths exist for Docker:

1. **Migrate the authenticated host profile** (section 7 step A) — preserves
   the live PrognoCIS session; the only path that works with MFA.
2. **`loginPerRun=true` headless auto-login** with `prognosis_username` /
   `prognosis_password` — fills the login form via Playwright; cannot complete
   MFA challenges, so it only works if the account does not enforce MFA or the
   volume profile session is already valid.

A container the first real run starts with an unauthenticated/localhost
profile **will fail with `AUTH_REQUIRED`** if neither path is arranged
(issue 10.1). This must be exercised in a supervised probe (checklist item 4)
before any scheduled ticket.

### 12.2 Run-lock release on stop — verified behavior

Verified against source: `src/cli.mjs` registers **no signal handlers** (grep
for `process.on` / `SIGTERM` / `SIGINT` / `beforeExit` in `src/` → 0 matches).
Consequences:

- The run lock (`src/runtime/lock.mjs`) is released only in the `finally` of a
  *normal* main() unwind (success or thrown JS error).
- SIGTERM (e.g. `docker compose stop`, or the entrypoint's
  `forward_signal`) terminates Node immediately **without** running `finally`,
  so `.runtime/writeback.lock` stays fresh for the full 6-hour stale window.
  A subsequent run fails with `RUN_ALREADY_ACTIVE` (exit 1) until the lock
  ages out or is removed.
- `docker-entrypoint.sh`'s comment that signal forwarding "releases the run
  lock" is **inaccurate for the lock file** — it only stops Chromium cleanly.
- This is identical to today's host behavior (host Node process has no handler
  either) — Docker does not make it worse, but the operator must know the
  procedure.

Operational procedure (documented in the checklist, item 7 — **not executed
in this phase**):

```bash
# 1. Confirm no live run exists first (fail-safe):
docker compose ps -a                      # no Running/Restarting writeback
docker ps                                 # no writeback container

# 2. Only then remove the stale lock from the volume and rerun:
docker run --rm \
  -v care1960-prognocis-writeback_writeback_runtime:/app/.runtime \
  care1960-prognocis-writeback:latest \
  sh -c 'rm -f /app/.runtime/writeback.lock'
```

Belt-and-braces note: do **not** `docker compose down -v` to clear a stale
lock — it destroys the browser profile and local verification proof (rollback
section 8).

### 12.3 Scheduler-user docker access (prerequisite, not performed)

The Docker wrapper (`scripts/writeback-wrapper.docker.template.sh`) executes
`docker compose run --rm -T writeback` under the Hermes cron user. That user
must have working `docker` CLI access to the daemon (docker group membership or
equivalent) and read access to the project root, `.env`, and `config/`. This
was **verified as a prerequisite only** — no system permission changes were
made (checklist item 2 gates the switch on a manual `docker compose run`
validation under that same user).

### 12.4 Environment variables — verified, docs corrected

- Source of truth: `src/runtime/config.mjs` `credentialsFromEnvironment()` and
  `.env.example`. Canonical names: `SUPABASE_ANON_KEY`, `SUPABASE_TENANT_API_KEY`,
  `prognosis_username`, `prognosis_password`, `CLINICAL_WRITE_ACK`.
- Stale names corrected in docs this phase (issue 10.4 → RESOLVED):
  `README.md`, `docs/PRODUCTION_SECOND_CRON.md`, `docs/CARE1960_INTEGRATION.md`,
  `docs/CARE1960_API_REQUIREMENTS.md`.
- `response.md` is a captured transcript artifact (kept verbatim — not
  operational documentation).

### 12.5 Wrapper template review (undertaken; template unchanged)

`scripts/writeback-wrapper.docker.template.sh` (29 lines) was reviewed:
`set -euo pipefail`, `umask 077`, `cd -- "$project_root"`,
`exec docker compose run --rm -T writeback`. Verdict: correct and minimal —
`exec` preserves the CLI exit code, `-T` is right for cron (no TTY), `--rm`
keeps the single-shot batch semantics, and the `umask` prevents world-readable
job artifacts. **No change needed.**

### 12.6 Runtime volume analysis (undertaken; no change)

`docker-compose.yml` mounts the named volume `writeback_runtime` at
`/app/.runtime` (browser profile, lock/audit/ledger, PHI-protected request
payloads). `read_only: true` rootfs, tmpfs `/tmp` and `/home/node` (uid 1000),
`no-new-privileges`, mem/pids caps, no published ports. The volume is the
persistent state and the rollback source for audit/ledger during the
transition; `down` keeps it, `down -v` destroys it. Confirmed: `.dockerignore`
excludes `.env`, `config/writeback.json`, `.runtime/`, and `node_modules`
(image stays clean); `.env.example` is re-included.

### 12.7 Migration safety / rollback / canary summary

- Migration = one-time additive `.runtime` copy (section 7 step A) with the
  host cron **paused** — the host path stays intact as rollback source.
- Rollback = restore the host wrapper via `scripts/install-hermes-cron.sh`
  (section 8); host `.runtime` never touched by Docker jobs.
- Canary = supervised `--max-records 1` probe then a supervised draft run with
  `--no-acknowledge` and approval gates (section 6 items 6-8); ledger repeat
  detection prevents duplicate writes on the same content.
- **Nothing was executed**: no `docker compose run` with real credentials, no
  cron/scheduler change, no volume copy/delete, no host wrapper replacement.

### 12.8 Phase 6 verification and file changes

Runs executed (all safe, no real credentials, no scheduler/volume/`.env`
changes):

- `node --check src/cli.mjs` — host syntax gate: **pass**.
- `docker run --rm care1960-prognocis-writeback:latest sh -c "cd /app && node --check src/cli.mjs && node --test"`
  — in-image gate: entrypoint passthrough works, syntax **pass**, Node test
  runner launches cleanly (0 tests executed because `test/` is not packaged in
  the image; source unchanged since the Phase 4/5 82/82 gate, so that gate
  still holds).
- `docker images` — `care1960-prognocis-writeback:latest` present
  (aa1e1070428c), built 2h ago (Phase 5).
- `docker compose config` — exit 1 with *"env file .env not found"*: this is
  the **documented expected behavior** (risk table: "compose config fails if
  `.env` is missing"); Phase 5 test B already proved it resolves with a
  throwaway `.env`. No `.env` was created this phase.
- `docker ps` — no writeback container running; only the unrelated
  `rcm-postgres-test` (0.0.0.0:5432) publishes ports.
- Evidence greps: signal handlers in `src/` → 0 matches; noVNC/VNC in Docker
  files → 0 matches; stale env names now only in `test/config.test.mjs`
  (asserts they are ignored), the captured `response.md` artifact, and this
  document's intentional historical quote.
- `git status --porcelain` / `git diff --stat` — diff bounded to 4 docs;
  see below.

Files changed this phase (docs only): `README.md`, `docs/PRODUCTION_SECOND_CRON.md`,
`docs/CARE1960_INTEGRATION.md`, `docs/CARE1960_API_REQUIREMENTS.md`,
`docs/DOCKER_PRODUCTION_TRANSITION.md`, plus new
`docs/DOCKER_PREPRODUCTION_CHECKLIST.md`. No `src/`, `test/`, `Dockerfile`,
`docker-compose.yml`, `docker-entrypoint.sh`, `package.json`, or scheduler
changes.