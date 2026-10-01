# Docker pre-production checklist (design only — NOT active)

> **Status: PLANNED. Nothing in this checklist has been executed.**
> Companion to [docs/DOCKER_PRODUCTION_TRANSITION.md](DOCKER_PRODUCTION_TRANSITION.md).
> Every item is a HUMAN action gated by explicit approval. The current
> production scheduler still runs the host-based wrapper; the Docker path must
> pass every item below before any switch. Phase 6 created/updated this
> document only — no item here was performed.
>
> **Phase 7 operator package:** the ordered migration procedure (PHASES A–I),
> the docker access precheck, and the image/runtime validation checklist are in
> [docs/DOCKER_MIGRATION_RUNBOOK.md](DOCKER_MIGRATION_RUNBOOK.md). Safety
> templates: `scripts/migrate-runtime-to-docker.template.sh` and
> `scripts/install-docker-wrapper.template.sh` — both NOT ACTIVE (template-only,
> dry-run default; neither writes into Hermes).

## Preconditions (before touching any runtime state)

- [ ] **(HUMAN ACTION)** Docker daemon is running and the `docker` CLI works on
      the target host. Verify: `docker version` (client + server) and
      `docker compose version` (v2 plugin required).
- [ ] **(HUMAN ACTION)** The user that will run the schedule (the Hermes cron
      user from `scripts/install-hermes-cron.sh`) can run
      `docker compose run --rm -T writeback validate-config` successfully as
      that same user (docker group access / daemon permission). This is a
      verified prerequisite — no permission changes were made in Phase 6.
- [ ] **(HUMAN ACTION)** No active `config/writeback.json` and no real `.env`
      exist in the repo during checkbacks; only `.env.example` is tracked
      (`git ls-files` shows no `.env`).
- [ ] **(HUMAN ACTION)** The project root is reachable at the same absolute
      path that will be substituted for `__PROJECT_ROOT__` in the Docker
      wrapper template.

## Configuration and image build

- [ ] **(HUMAN ACTION)** `docker compose config` resolves with a throwaway
      `.env` created from `.env.example` (no real secrets). Confirm: env_file
      injection of the 5 canonical variables, `read_only`, tmpfs uid/gid,
      `restart: 'no'`, mem 2g, pids 512, **no ports**, volume declared.
- [ ] **(HUMAN ACTION)** `docker compose build` exits 0 and the image
      `care1960-prognocis-writeback:latest` is present.
- [ ] **(HUMAN ACTION)** `node src/cli.mjs validate-config --config config/writeback.json`
      passes (unchanged host gate) with the real (thrown-away-after) config.
- [ ] **(HUMAN ACTION)** Smoke: `docker compose run --rm -T writeback` with NO
      active config fails cleanly (Chromium starts, CDP ready, "Configuration
      not found", Chromium stopped, exit 1 propagates). See transition doc
      section 11, test D.

## Authentication readiness (transition doc §10.1 / §12.1)

- [ ] **(HUMAN ACTION)** Confirm the PrognoCIS login used by the **container**
      profile is live. The container has NO VNC/noVNC surface, so choose one
      of:
      1. Migrate the authenticated host `.runtime` profile into the volume
         (transition doc section 7 step A) — the only MFA-compatible path, or
      2. `loginPerRun=true` with `prognosis_username`/`prognosis_password`
         (fails on MFA; only valid if the account has no MFA challenge).
- [ ] **(HUMAN ACTION)** Run a supervised probe with no writes:
      `docker compose run --rm -T writeback probe --max-records 1` — exits 0,
      reads back the encounter, audit shows no writes.

## Lock and concurrency (transition doc §12.2)

- [ ] **(HUMAN ACTION)** Confirm `.runtime/writeback.lock` in the volume is
      either absent or stale before any real job. Stale-lock removal after a
      stopped/killed job (only after confirming no live run):
      `docker ps` shows no writeback container, then
      `docker run --rm -v care1960-prognocis-writeback_writeback_runtime:/app/.runtime care1960-prognocis-writeback:latest sh -c 'rm -f /app/.runtime/writeback.lock'`.
      **Never** use `docker compose down -v` for this (destroys profile +
      verification proof).
- [ ] **(HUMAN ACTION)** Confirm the 6-hour stale-lock policy is acceptable to
      the operator (a killed job blocks reruns up to 6h — identical to the
      host today).

## Canary (designed, NOT executed — transition doc §12.7)

- [ ] **(HUMAN ACTION)** Pause the host cron job (`care1960-prognocis-clinical-drafts`)
      during validation to avoid double-processing the same page.
- [ ] **(HUMAN ACTION)** Supervised draft canary:
      `docker compose run --rm -T writeback run --config config/writeback.json --max-records 1 --no-acknowledge`
      with approval gates; verify HPI/ROS/PE read-back, draft status, exit
      code, and audit/ledger rows in the volume.
- [ ] **(HUMAN ACTION)** Repeat the same canary content once; confirm NO
      additional writes (ledger repeat detection).
- [ ] **(HUMAN ACTION)** Confirm `docker ps` PORTS column is empty during a
      run (no host port published; no noVNC/VNC surface exposed).

## Rollback readiness (transition doc §8)

- [ ] **(HUMAN ACTION)** Host wrapper + installer intact:
      `${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh`
      still points at `node src/cli.mjs run`; restoring is
      `bash scripts/install-hermes-cron.sh`.
- [ ] **(HUMAN ACTION)** Host `.runtime/` retained untouched as the rollback
      data source; the migration copy is additive only.

## Switch gate (only after every box above)

- [ ] **(HUMAN ACTION, explicit approval)** Generate and install the Docker
      wrapper (transition doc section 7 step B), run it once manually without
      credentials (expect clean exit 1), then let the first scheduled tick run.
- [ ] **(HUMAN ACTION)** Watch the first scheduled tick: exit code 0,
      audit/ledger rows written in the volume, `docker compose ps -a` shows the
      finished run.
- [ ] **(HUMAN ACTION)** Post-switch watch window (≥2 weeks): any `AUTH_REQUIRED`,
      `RUN_ALREADY_ACTIVE`, or lock complaint triggers the rollback procedure
      above; operator keeps rollback ready during the entire window.

## Phase 6 file state (no checklist item executed)

- Files changed this phase (docs only): `README.md`,
  `docs/PRODUCTION_SECOND_CRON.md`, `docs/CARE1960_INTEGRATION.md`,
  `docs/CARE1960_API_REQUIREMENTS.md`, `docs/DOCKER_PRODUCTION_TRANSITION.md`,
  this file. No `src/`, `Dockerfile`, `docker-compose.yml`,
  `docker-entrypoint.sh`, `package.json`, `.env`, active config, volume, or
  scheduler changes.