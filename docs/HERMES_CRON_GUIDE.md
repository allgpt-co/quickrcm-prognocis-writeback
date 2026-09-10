# Hermes Cron Guide: PrognoCIS and QuickRCM

Last updated: September 5, 2026

## Purpose

Hermes should run **two separate no-agent cron jobs**, one for each direction:

| Hermes job | Direction | Purpose |
|---|---|---|
| `prognocis-quickrcm-daily-dev` | PrognoCIS → QuickRCM | Import the next day's patients and appointments. This is the existing six-script pipeline. |
| `quickrcm-prognocis-clinical-drafts` | QuickRCM → PrognoCIS | Return provider-attested QuickScribe HPI, ROS, Physical Examination, and accepted ICD-10-CM codes to the exact encounter as an open draft. |

These must remain independent. The reverse job must never sign, finalize, close, electronically attest, or send an encounter to claims.

## Important: do not create six cron jobs

The six existing PrognoCIS-to-QuickRCM files form **one invocation chain**. Hermes schedules only the shell wrapper; that wrapper and its Python runner invoke the other five components.

```text
Hermes: prognocis-quickrcm-daily-dev
  └─ run_prognocis_quickrcm_daily.sh
      └─ scripts/prognocis_quickrcm_daily.py
          ├─ scripts/prognocis_quickrcm_standalone.py
          │   └─ cognitive_automator/prognocis/quickrcm_standalone.py
          │       └─ cognitive_automator/prognocis/appointments.py
          └─ cognitive_automator/quickrcm/daily_live_sync.py
```

### Existing six deployed components

The existing production deployment was last inspected in the Hermes container at `/home/hermes/.hermes`:

| # | Container path | Responsibility |
|---|---|---|
| 1 | `scripts/run_prognocis_quickrcm_daily.sh` | Cron entry point and private runtime setup. |
| 2 | `prognocis-vob/scripts/prognocis_quickrcm_daily.py` | Daily orchestration, validation, checkpointing, and reporting. |
| 3 | `prognocis-vob/scripts/prognocis_quickrcm_standalone.py` | Browser-extraction command adapter. |
| 4 | `prognocis-vob/cognitive_automator/prognocis/quickrcm_standalone.py` | Rendered PrognoCIS appointment extraction. |
| 5 | `prognocis-vob/cognitive_automator/prognocis/appointments.py` | Strict appointment parsing and normalization. |
| 6 | `prognocis-vob/cognitive_automator/quickrcm/daily_live_sync.py` | Idempotent QuickRCM patient and appointment synchronization. |

The existing job was documented with schedule `0 22 * * *`. Confirm its current schedule with `hermes cron list` before installing the reverse job.

## Current activation status

- The supervised development canary for QuickRCM-to-PrognoCIS draft write-back passed, including exact encounter read-back and an idempotent second run.
- The reverse Hermes job was **not installed by this documentation change**. The deployed Hermes environment must first provide its private `.env` acknowledgement, authenticated Chrome/CDP session, and a passing read-only probe.
- The production Docker volume was not accessible from the documentation workspace, so the existing forward job and its schedule must be rechecked in the actual Hermes runtime before enabling the reverse schedule.

## New QuickRCM-to-PrognoCIS cron chain

The new reverse workflow is owned only by this repository:

```text
/home/hermes/.hermes/quickrcm-prognocis-writeback
```

Hermes schedules one generated wrapper:

```text
~/.hermes/scripts/quickrcm-prognocis-clinical-drafts.sh
  └─ node src/cli.mjs run --config config/writeback.json
      ├─ src/integrations/quickscribe-browser.mjs
      ├─ src/workflow/writeback.mjs
      ├─ src/integrations/prognocis-browser.mjs
      └─ src/runtime/ledger.mjs
```

Only the generated wrapper is registered with Hermes. The JavaScript modules are called internally by the Node CLI.

Do **not** install `ehr-attestation-automation/scripts/install-clinical-hermes-cron.sh`. That file belongs to an older reverse-flow prototype and uses the same job and wrapper names. The canonical reverse implementation is now this `quickrcm-prognocis-writeback` repository.

## Scheduling rule

Both directions use PrognoCIS, so they must not control the same browser simultaneously. Their repository locks are separate and do not provide cross-job exclusion.

The reverse installer therefore defaults to:

```cron
15 0-20,23 * * *
```

This polls at minute 15 while avoiding hours 21 and 22 around the documented 22:00 forward synchronization. If the forward schedule changes, change the reverse schedule too. Verify the Hermes/container clock with `date`; cron expressions use the scheduler's local timezone.

Start with `automation.maxRecordsPerRun: 1`. Raise it only after reviewing runtime duration and confirming there is still no schedule overlap.

## Prerequisites

Run the reverse job as the same OS user that owns the Hermes home, browser profile, configuration, and runtime ledger.

1. Deploy this repository inside the persistent Hermes volume, preferably at:

   ```text
   /home/hermes/.hermes/quickrcm-prognocis-writeback
   ```

2. Confirm Node.js 22 or newer and install locked dependencies:

   ```bash
   node --version
   npm ci --omit=dev
   ```

3. Keep the active configuration and environment private:

   ```bash
   chmod 600 .env config/writeback.json
   chmod 700 .runtime
   ```

4. In `.env`, store the four portal credentials under these exact names, plus the fixed write acknowledgement:

   ```dotenv
   Quick_rcm_email=
   Quick_rcm_password=
   prognosis_username=
   prognosis_password=
   CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES
   ```

   The browser uses these values only when the corresponding login form is visible. It verifies the configured QuickRCM organization after login and fails closed if the organization is missing or ambiguous. Never place credential values in the cron command, Git, logs, screenshots, or this guide.

5. Confirm the shared headed Chrome is running and CDP `127.0.0.1:9223` is reachable. QuickRCM and PrognoCIS run in the same reverse-flow profile. Keep CDP, VNC, and noVNC bound to localhost.

6. Set `prognocis.loginPerRun` to `true`. Before CDP attachment, the runner closes only stale PrognoCIS login/login-action targets on the configured origin; it preserves the active patient application and all unrelated origins.

7. Set a long Hermes script timeout because browser saves and read-back verification can exceed the default:

   ```bash
   hermes config set cron.script_timeout_seconds 3600
   ```

## Pre-install verification

From the deployed reverse repository:

```bash
cd /home/hermes/.hermes/quickrcm-prognocis-writeback

# Code and automated tests.
npm run check

# Structure, selectors, draft-only gate, and acknowledgement.
npm run validate:config -- --config config/writeback.json

# Read-only exact patient/encounter probe.
npm run probe -- --config config/writeback.json --max-records 1
```

The probe must report one probed record and zero failures before installation. A live canary has already passed in the development workspace, but the probe must be repeated from the deployed Hermes runtime to prove its Chrome/CDP and file permissions.

## Install the reverse cron

Preview without modifying Hermes:

```bash
./scripts/install-hermes-cron.sh --dry-run "15 0-20,23 * * *" local
```

Install or update the no-agent job:

```bash
./scripts/install-hermes-cron.sh "15 0-20,23 * * *" local
```

The installer:

1. finds Node and Hermes;
2. validates the live configuration;
3. writes `~/.hermes/scripts/quickrcm-prognocis-clinical-drafts.sh` with mode `0700`; and
4. creates or updates `quickrcm-prognocis-clinical-drafts` in no-agent mode.

No-agent mode is intentional: the deterministic browser script runs without an LLM, conversational memory, or Codex tokens.

## Verify Hermes after installation

```bash
hermes gateway status
hermes cron status
hermes cron list
```

Confirm the list contains these relevant intended jobs and wrapper names. Other unrelated Hermes jobs may also be present:

```text
prognocis-quickrcm-daily-dev       -> run_prognocis_quickrcm_daily.sh
quickrcm-prognocis-clinical-drafts -> quickrcm-prognocis-clinical-drafts.sh
```

To test the scheduled entry without waiting for its next time, obtain its job ID from `hermes cron list`, then run:

```bash
hermes cron run <reverse-job-id>
```

Do this only while the forward job is not running.

## Expected reverse-job result

A successful run prints a PHI-free summary similar to:

```json
{"mode":"draft-write","queued":1,"probed":0,"verified":1,"skipped":0,"duplicates":0,"failed":0}
```

A later run of the same artifact should increment `skipped` instead of writing it again. The private files are:

| File | Purpose |
|---|---|
| `.runtime/writeback-audit.jsonl` | PHI-free stage, status, duration, and error-code events. |
| `.runtime/verified-drafts.jsonl` | Verified artifact hashes and opaque proof used for idempotency. |
| `.runtime/writeback.lock` | Prevents overlapping runs of this reverse job. |

Never delete the verification ledger during ordinary deployment or restart; doing so removes duplicate-write protection.

## Monitoring and recovery

Monitor these controlled failures:

- `AUTH_REQUIRED`: pause the reverse job, restore QuickRCM/PrognoCIS authentication through noVNC, confirm only one PrognoCIS application window, run the probe, then resume.
- `CLINICAL_TEXT_CONFLICT`: do not overwrite; send the encounter for human review.
- `UNEXPECTED_DIALOG`: pause and inspect the headed browser before retrying.
- `DRAFT_READBACK_FAILED`: do not sign or close; reconcile the open encounter manually before another run.
- selector or exact-match failures: pause the job and update/test selectors rather than adding a broad fallback.

Useful commands:

```bash
hermes cron pause <reverse-job-id>
hermes cron resume <reverse-job-id>
hermes cron list
tail -n 50 .runtime/writeback-audit.jsonl
```

## Emergency stop and rollback

Use all three controls for a deliberate shutdown:

1. Pause the Hermes reverse job.
2. Set `automation.writeEnabled` to `false` in `config/writeback.json`.
3. Remove or change `CLINICAL_WRITE_ACK` in the private `.env` file.

Then run `npm run validate:config` and a read-only probe. Do not delete the forward job, the browser profile, audit history, or the verification ledger.

## Deployment checklist

- [ ] Existing six-file forward pipeline remains unchanged.
- [ ] Old `install-clinical-hermes-cron.sh` prototype is not installed.
- [ ] New reverse repository is inside the persistent Hermes volume.
- [ ] Node.js 22+, dependencies, configuration, and owner-only permissions are verified.
- [ ] Draft-only mode and exact `CLINICAL_WRITE_ACK` are present.
- [ ] Shared Chrome/CDP is running and both applications are authenticated.
- [ ] Reverse read-only probe passes from the Hermes runtime.
- [ ] Forward and reverse schedules cannot overlap.
- [ ] Hermes timeout is at least 3,600 seconds.
- [ ] Both jobs are no-agent and point to the correct wrapper.
- [ ] A manual scheduled run succeeds and a repeat is idempotently skipped.
- [ ] A human owner is assigned for authentication and clinical-conflict alerts.
