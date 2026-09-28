# Docker Migration Runbook

**Final operator package** — `quickrcm-prognocis-writeback` host → Docker transition.

- Status: **NOT YET EXECUTED**. This runbook phases the migration; nothing in it activates production.
- Companion docs: `docs/DOCKER_PRODUCTION_TRANSITION.md` (architecture), `docs/DOCKER_PREPRODUCTION_CHECKLIST.md` (24 human-action items).
- Companion templates: `scripts/migrate-runtime-to-docker.template.sh`, `scripts/install-docker-wrapper.template.sh`, `scripts/writeback-wrapper.docker.template.sh`.

---

## 0. Operator position

You are the **only** person who flips production. Each phase ends with an explicit
"exit gate": a list of checks that must pass and a STOP. If any gate fails, roll
back per PHASE H before touching anything else.

Do NOT run any of these commands during development, review, or CI. This runbook
is executed by a human operator at the scheduled migration window.

---

## 1. Fixed identifiers

| Thing | Value |
|---|---|
| Compose service | `writeback` |
| Image | `care1960-prognocis-writeback:latest` |
| Stable tags | `:phase2`, `:phase1b` |
| Runtime volume (host) | `.runtime/` (project root) |
| Runtime volume (docker, named) | `care1960-prognocis-writeback_writeback_runtime` |
| In-container runtime path | `/app/.runtime` |
| Host Hermes wrapper | `${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh` |
| Docker wrapper template | `scripts/writeback-wrapper.docker.template.sh` |
| Config/credentials | `config/writeback.json`, `.env` (both absent, both never committed) |
| CDP | `127.0.0.1:9223` loopback inside container only (noVNC absent) |

---

## 2. PHASE A — Preflight (read-only)

Goal: prove the operator has the tools, credentials, and a stable baseline BEFORE
anything changes.

### 2.1 Docker access precheck

Run each; all must succeed:

```bash
docker version                       # client AND server reachable
docker compose version
docker compose config                # valid compose file; requires .env (see below)
docker compose run --rm -T writeback validate-config   # only AFTER .env+config exist
```

> `docker compose config` fails with `env file .env not found` until the
> operator supplies the real `.env` at the migration window. That failure is
> EXPECTED pre-window, not a defect — the image itself builds without `.env`.

### 2.2 Credentials

The operator must have, in-hand, at the window:

- `config/writeback.json` (real tenant credentials) — created from
  `config/writeback.example.json`; never committed, never in the image.
- `.env` (the five canonical runtime variables — `SUPABASE_ANON_KEY`,
  `SUPABASE_TENANT_API_KEY`, `prognosis_username`, `prognosis_password`,
  `CLINICAL_WRITE_ACK` — per `docs/DOCKER_PRODUCTION_TRANSITION.md` §10.4;
  the application does not read any other variable, so no additional Supabase
  URL variable is needed) — created from `.env.example`; never committed.
- Herpes MFA token source for the clinical login (see PHASE B).

### 2.3 Baseline snapshot

```bash
git status --porcelain        # record expected modified/untracked set
docker images                 # image present + digest recorded
docker ps                     # only rcm-postgres-test (port 5432) expected
docker volume ls              # runtime volume may NOT exist yet (fine)
```

### Exit gate A

- [ ] Docker client + server reachable
- [ ] Compose config parses
- [ ] Real `.env` + `config/writeback.json` in place (not committed)
- [ ] Image present, digest recorded
- [ ] No unexpected running containers

---

## 3. PHASE B — Authentication (login state)

The container has **no persistent GUI browser and no display**; CDP is
loopback-only. The prior host-era `--no-vnc` hint is obsolete (§10.1).

Two modes:

**MFA (production default)** — profile does NOT persist cross-session:

1. Ensure `loginPerRun: true` in `config/writeback.json` (or per-transition
   config section).
2. `validate-config` (PHASE A) confirms the auth block.
3. Each supervised run performs a fresh login; the operator enters MFA through
   the supervised canary flow (PHASE E) — walk through the browser CDP at
   `127.0.0.1:9223` from inside the container run itself.

**No MFA (staging/test only)**:

1. Profile persists at `/app/.runtime/shared-clinical-browser-profile` (named
   runtime volume).
2. First login populates the profile; subsequent runs reuse it.
3. Never treat the profile as a secret store — it is a scratch artifact.

### Exit gate B

- [ ] Auth mode chosen and documented in the transition change record
- [ ] `validate-config` passes with the real credentials
- [ ] No credentials appear in the image (`docker history` scan, §6.11)

---

## 4. PHASE C — Runtime migration (one-time, additive)

Goal: copy the host `.runtime` **into** the named Docker volume. The host
directory is NEVER modified or deleted. Named volume survives container
lifecycles.

### 4.1 Window discipline

1. Pause the host Hermes cron job
   `care1960-prognocis-clinical-drafts` (the ONLY scheduler pause of the runbook).
2. Confirm no live run: the readiness probe answers `no patients to check`, or
   the previous invocation completed.

### 4.2 Copy (operator-substituted, execute mode)

```bash
scripts/migrate-runtime-to-docker.template.sh \
  --source /absolute/path/to/.runtime \
  --volume care1960-prognocis-writeback_writeback_runtime \
  --execute
```

The template: fails closed if placeholders are un-substituted; refuses if a
writeback container is running; refuses to overwrite existing volume files;
never `down -v`, never `volume rm`, never deletes the host source.

> If the template shows "COULD OVERWRITE" — the volume already holds files.
> Resolve the target side first (this is the repeat-protection of PHASE F
> kicking in). Never force-overwrite production proof (audit file, lock state).

### 4.3 Verify the volume state

```bash
docker run --rm \
  -v care1960-prognocis-writeback_writeback_runtime:/app/.runtime \
  care1960-prognocis-writeback:latest \
  sh -c 'find /app/.runtime -maxdepth 2 | sort'
```

Expected: the same file set as the host `.runtime` (shared browser profile,
writeback-audit.jsonl, etc.) — **plus** nothing unexpected.

### Exit gate C

- [ ] Host `.runtime` byte-identical before/after (sha256 sum of a sample set)
- [ ] Volume file set matches host set
- [ ] Volume mounted read-only config, runtime writable
- [ ] Host cron still paused (held for PHASE G)

---

## 5. PHASE D — Docker validation (no writes)

Goal: prove the image behaves in the container as it did on the host, with the
production `.env`/config but WITHOUT writing to any clinical system.

```bash
docker compose run --rm -T writeback validate-config

# no-op probe: reads scheduling state, writes NOTHING clinical
docker compose run --rm -T writeback probe --max-records 1

# auth gate check (from the transition doc §10.1): expects AUTH_REQUIRED output
docker compose run --rm -T writeback run --config config/writeback.json --max-records 1 --no-acknowledge
```

> The last command is the **pre-canary auth probe**: a `run` invocation that
> MUST stop at the authentication gate (AUTH_REQUIRED error, per §10.1) —
> proving the run pipeline is wired without touching patient data.

### Exit gate D

- [ ] `validate-config` exit 0
- [ ] `probe` exit 0, no patients to check (or expected set)
- [ ] Auth probe stops at the gate (AUTH_REQUIRED) — no clinical write

---

## 6. Image / runtime validation checklist

Run against the image (`docker history`, runtime probes, inspect):

1. **Image exists** and sha256 digest recorded (stable tags drifted checked).
2. **One tag per build epoch**: `:latest`, `:phase2`, `:phase1b`.
3. **Chromium present** and launches via CDP `127.0.0.1:9223` loopback.
4. **Node runtime** matches host-era version contract (the container wraps the
   same `src/cli.mjs`).
5. **Non-root** `USER node`.
6. **Read-only rootfs** (`read_only: true`), tmpfs for scratch, runtime on the
   named volume.
7. **`config/` mounted ro** — `/app/config` is not writable at runtime.
8. **No host port 9223** — `ports:` absent in `docker-compose.yml` (confirm).
9. **No VNC/noVNC** — the transition doc §10.1 marked the hint obsolete.
10. **No restart loop** — `restart: "no"`, `init: true`.
11. **No secrets baked** — `docker history` + `docker inspect` show no
    credentials; config/`.env` are runtime mounts only.
12. **Wrapper contract** — the installed wrapper's last line is
    `exec docker compose run --rm -T writeback` (exit code propagates).

---

## 7. PHASE E — Supervised canary (one real patient, no acknowledge)

The single production-touching test. Run it yourself, watch it, record proof.

```bash
docker compose run --rm -T writeback run \
  --config config/writeback.json \
  --max-records 1 \
  --no-acknowledge
```

### What must happen

1. Selection: exactly 1 patient draft from `candidate-clinical-drafts`.
2. Read-back (`HPI-ROS-PE`) matches the draft the operator inspected.
3. No `prognosis_write_ack` — `--no-acknowledge` guarantees zero clinical
   acknowledgment side effects.
4. Audit/ledger entries for the single processed draft.
5. Exit code 0 (writeback-complete).
6. Browser profile written to the named volume; container exited `--rm`.

### Canary proof captured

```bash
docker compose logs --no-color writeback   # run-id, patient-id, HPI-ROS-PE hash
docker run --rm -v care1960-prognocis-writeback_writeback_runtime:/app/.runtime \
  care1960-prognocis-writeback:latest \
  sh -c 'tail -n 20 /app/.runtime/writeback-audit.jsonl'
```

### Exit gate E

- [ ] 1 record, correct patient, correct draft
- [ ] No acknowledge (`.no_acknowledge` sentinel)
- [ ] Audit ledger shows the canary record
- [ ] Exit code + profile persisted to volume

---

## 8. PHASE F — Repeat protection

The canary **must not** be re-run:

1. Delete the canary record from the clinical draft source (operator CRUD),
   or mark it processed so the next probe finds nothing.
2. Never re-run PHASE E — the one real written record is the migration's
   proof, not a fixture.
3. The `migrate-runtime-to-docker` template refuses re-copy when volume files
   exist (collision refusal) — the named volume is now the source of truth.

### Exit gate F

- [ ] Canary record consumed; next `probe` shows no unexpected drafts
- [ ] Volume collision-refusal left in place (template unchanged)

---

## 9. PHASE G — Scheduler switch

Goal: point Hermes at the Docker wrapper instead of the Node host wrapper,
without re-registering the cron job (job identity stays the same).

1. Stage the Docker wrapper locally (this does NOT touch Hermes):

```bash
scripts/install-docker-wrapper.template.sh \
  --project-root /absolute/path/to/project --generate
```

2. Verify the staged wrapper (last line must be the exec command).

3. Back up the current host wrapper, then install the Docker wrapper BY HAND
   (the template explicitly refuses to write into Hermes):

```bash
cp "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh" \
   "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh.host-backup"

sed -e "s|__PROJECT_ROOT__|/absolute/path/to/project|g" \
    scripts/writeback-wrapper.docker.template.sh \
    > "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
chmod 700 "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
```

4. Re-enable the paused cron job (same schedule, same name).
5. First tick is a supervised candidate: watch logs. The Docker wrapper
   invokes the normal `run` subcommand (`docker compose run --rm -T writeback`
   maps to the service command `run --config config/writeback.json`), so the
   first scheduled tick is NOT inherently a probe and `--no-acknowledge` is NOT
   applied automatically by the wrapper. First-tick no-write safety depends on
   the production configuration being write-disabled: verify
   `automation.writeEnabled=false` in `config/writeback.json` before the first
   tick, and verify the required `CLINICAL_WRITE_ACK` acknowledgement mechanism
   (the sentinel value in `.env`) is still withheld/absent so nothing can be
   acknowledged. The first tick must be supervised. If a true no-write probe is
   required instead, run it explicitly:
   `docker compose run --rm -T writeback probe --max-records 1`.

### Exit gate G

- [ ] Host wrapper backed up (`.host-backup`)
- [ ] Docker wrapper in place, `chmod 700`
- [ ] Cron job re-enabled, same schedule
- [ ] First tick supervised; `automation.writeEnabled=false` verified in
  `config/writeback.json`; no acknowledgement sentinel in `.env` (or an
  explicit `probe --max-records 1` was run instead)

---

## 10. PHASE H — Rollback (any gate fails, or incidents within watch window)

Ordered from least to most destructive. Stop at the first step that restores
service.

1. **Restore the host wrapper** (undoes PHASE G only):

```bash
cp "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh.host-backup" \
   "${HERMES_HOME:-$HOME/.hermes}/scripts/care1960-prognocis-clinical-drafts.sh"
```

2. **Re-run the host flow**: `scripts/install-hermes-cron.sh` (restores host
   wrapper + re-registers the job if registry was touched).

3. **Keep the named volume** — it is the persistent runtime; rolling back the
   scheduler does NOT delete it.

4. **Never** `docker compose down -v`, `docker volume rm`, or delete the host
   `.runtime` — the audit ledger the operator may need for compliance lives in
   both places.

**Rollback = scheduler on host, volume retained.** The volume being retained is
what makes the re-migration additive rather than destructive (PHASE C guard).

### Exit gate H

- [ ] Host wrapper restored and verified (`grep 'node_bin'` present)
- [ ] Cron job live on the host flow
- [ ] Named volume untouched, host `.runtime` untouched

---

## 11. PHASE I — Post-switch monitoring (≥ 2-week watch window)

After PHASE G re-enables the cron:

1. **Window**: a minimum of 14 consecutive days, two full clinical reporting
   cycles.
2. **Watch list** (each mapped to the runbook's known behaviors):
   - `AUTH_REQUIRED` — auth gate failures (PHASE B config regression).
   - `RUN_ALREADY_ACTIVE` — overlap (stale-lock policy; §12 cleanup command in
     the transition doc if genuinely stale).
   - audit/ledger growth on the named volume (canary + daily records).
   - exit codes: nonzero consecutive runs = incident.
   - browser profile rotation / CDP failures (`127.0.0.1:9223`).
3. **Alerting**: every nonzero exit at the cron level lands in the same channel
   the host-era job used.
4. **After the window**:
   - Promote the image tag epochs if needed (`docker tag ... :migrated`).
   - Leave `:latest` pinned to the validated digest.
   - Archive the canary evidence (PHASE E proof) in the change record.

### Exit gate I

- [ ] 14+ days, ≥2 clinical cycles, zero acknowledgment failures
- [ ] Canary proof archived
- [ ] Digest pinned, tags promoted

---

## 12. Secrets & hygiene (applies to every phase)

- Real credentials: ONLY at the migration window, ONLY via `.env` /
  `config/writeback.json` mounts. No secrets in logs, shell history, or git.
- `git status` is clean of `.env`, `config/writeback.json`, `.runtime/`,
  wrapper installs, scheduler edits.
- Everything above is a DOCUMENT. Nothing in this runbook has been executed
  against production.

---

## 13. Checklist cross-reference

| Runbook phase | Preproduction checklist items (docs/DOCKER_PREPRODUCTION_CHECKLIST.md) |
|---|---|
| A preflight | 1–5 (tools, credentials, baseline) |
| B auth | 6–9 |
| C runtime | 10–13 |
| D validate | 14–17 |
| E canary | 18–20 |
| G switch | 21–23 |
| I monitor | 24 |