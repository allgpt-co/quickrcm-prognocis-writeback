# Care1960 API to PrognoCIS writeback

The input is the JSON output of the Care1960 API. Playwright opens only
PrognoCIS, matches the patient and encounter, and writes HPI, ROS, and Physical
Examination as narrative text. The source browser scraper and note-heading
parser have been removed.

```text
Care1960 POST response (HTTP or captured JSON file)
  -> validate tenant, ATTESTED status, attestation, patient/encounter IDs
  -> map HPI + ROS + Physical Examination
  -> match the exact PrognoCIS patient and encounter
  -> stop on conflicting existing text; save missing sections as a draft
  -> reopen and verify all three sections and draft status
  -> record local verification proof; skip the same verified content on repeats
```

## Setup

```bash
npm ci
cp .env.example .env
cp config/writeback.example.json config/writeback.json
npm run check
```

Set `care1960.orgId` to the expected organization UUID and configure the
PrognoCIS selectors in `config/writeback.json`. The example organization and
response file contain synthetic data. Active configuration, credentials, and
runtime payloads are ignored by Git.

## Docker Compose (container runtime)

The Compose file runs the existing single-container architecture: Node worker,
headless Chromium, and CDP stay inside ONE container (CDP bound to
`127.0.0.1:9223`, never published to the host). It is a single-shot batch job —
`restart: "no"`, no web server, no exposed ports. An external scheduler invokes
the job; nothing runs cron inside the container.

```bash
# 1. Build the image.
docker compose build

# 2. Prepare the runtime inputs (neither enters the image):
cp .env.example .env                          # fill in the secrets
cp config/writeback.example.json config/writeback.json  # set orgId + selectors

# 3. Run the production writeback job. The exit status is the job's exit code.
docker compose run --rm writeback
```

- `.env` is injected at run time (`env_file`) and never baked into the image.
- `config/` is mounted read-only at `/app/config`; a missing
  `config/writeback.json` fails cleanly inside the app (exit 1).
- `.runtime/` persists in the `writeback_runtime` named volume (browser
  profile, lock/audit/ledger, verification proof) across job runs.
- Hardened image filesystem: the root filesystem is read-only at run time;
  only `/app/.runtime` (named volume), `/tmp`, and `/home/node` (both tmpfs,
  the home mounted uid=1000,gid=1000 for the non-root node user) are writable.
  `no-new-privileges` is enabled, container logs are rotated (json-file
  driver, 10m x 3), and memory/pids are capped from measured runtime values
  (2g, 512). Chromium needs a writable `$HOME` for its crashpad database; if
  the `/home/node` tmpfs had root:root default ownership Chromium would abort
  at startup — it stays owned by uid=1000.
- Logs: `docker compose logs writeback`; status of a finished job:
  `docker compose ps -a`.
- Stop/clean: `docker compose stop` ends the job gracefully (the entrypoint
  stops Chromium); `docker compose down` removes the container and network but
  KEEPS the named volume. `docker compose down -v` also deletes the volume, so
  the browser profile and local verification proof are destroyed — use it only
  deliberately.
- A non-interactive scheduler should add `-T`:
  `docker compose run --rm -T writeback`.

> **Production scheduler transition (planned, NOT active).** The Hermes cron
> job (`care1960-prognocis-clinical-drafts`, installed by
> `scripts/install-hermes-cron.sh`) still runs the host-based wrapper
> (`exec node src/cli.mjs run --config config/writeback.json`). The Docker
> equivalent — `scripts/writeback-wrapper.docker.template.sh` →
> `docker compose run --rm -T writeback` — exists as a template only and is
> not wired into any scheduler. Do NOT switch the scheduler until the manual
> validation checklist in
> [docs/DOCKER_PRODUCTION_TRANSITION.md](docs/DOCKER_PRODUCTION_TRANSITION.md)
> has passed.

## Input from an existing API response

Save the POST response privately as `.runtime/care1960-response.json`. The
default `care1960.input` is `response-file`. Response validation can run before
PrognoCIS selectors or login are configured:

```bash
# Synthetic adapter example; no browser, network, or EHR writes.
npm run validate:response -- --config config/writeback.example.json \
  --response config/care1960-response.example.json

# Validate the actual response using the configured field mappings.
npm run validate:response -- --response .runtime/care1960-response.json

# Validate configuration, then open the matching encounter without filling it.
npm run validate:config
npm run probe -- --response .runtime/care1960-response.json --max-records 1

# Write drafts once automation.writeEnabled and CLINICAL_WRITE_ACK are set.
npm run run -- --response .runtime/care1960-response.json --max-records 1

# Supervised draft writes and read-back, without marking the source written_back.
npm run run -- --config config/writeback.json --max-records 1 --no-acknowledge
```

`run --no-acknowledge` keeps draft/conflict/read-back safeguards and local
verification proof, but never calls the source acknowledgement endpoint, marks
local acknowledgement, or advances the API cursor. A verified replay does not
rewrite the EHR. A later normal run can acknowledge a locally verified draft;
keep this flag on all runs while deliberately withholding acknowledgement.

`--response` selects file input even if the configuration uses HTTP. Relative
paths are resolved from the repository root. Protect captured responses and
request bodies with owner-only permissions because they can contain PHI.

## Direct POST input

Migration `0010` provides this read-only clinical endpoint:

```text
POST http://127.0.0.1:54321/rest/v1/rpc/care1960_get_attested_clinical_records
```

Set `care1960.input` to `http` and use the endpoint for the intended Supabase
instance after applying the migration there. Copy the [request example](config/care1960-request.example.json)
to `.runtime/care1960-request.json` and replace its synthetic identifiers with
the exact patient, encounter, and clinical job to process.

Both credentials are required in `.env`: `SUPABASE_ANON_KEY` supplies the Supabase
instance's gateway anon key in `apikey`; `SUPABASE_TENANT_API_KEY` supplies a
registered, live Care1960 tenant API JWT in `Authorization`. Use credentials
from the same backend instance. There is no fallback between the two.

Each invocation sends the POST once and consumes that response. It does not
retry timeouts, follow redirects, or repeat the POST during writeback checks.
`validate:response` and `probe` also send the POST in HTTP mode. This clinical
RPC reads attested records without updating appointment or export state.

The file source is reread before/after EHR writes. HTTP mode checks the captured
response rather than fetching current upstream state. In normal write mode,
verified drafts are acknowledged through `care1960.markWrittenBackUrl`; local
verification proof allows a later run to recover a failed acknowledgement
without rewriting the EHR.

Use an exact-job request for the first canary. The fetch RPC excludes records
marked `written_back=true`, so a first-page queue request moves on after successful
acknowledgement or failure retirement. Keep `p_limit` within the writer's record
limit. If `care1960.cursorFile` is configured, the cursor advances only after all
selected records are resolved; probe and no-ack runs never advance it.

## Bounded retries

Set `automation.maxRetries: 2`, `runtime.retryLedgerFile` to
`.runtime/writeback-retries.json`, and `care1960.setRetryFailedUrl` to the
same backend's `/rest/v1/rpc/care1960_set_clinical_export_retry_failed` endpoint.
The live configuration and example include these settings. The retry RPC uses
the same gateway key and tenant bearer token as the read and acknowledgement RPCs.

Each job receives an initial attempt and up to two retries across normal HTTP
write runs, one attempt per run. The private retry file persists the count before
EHR processing, including across process restarts; an interrupted attempt counts.
The key includes the organization and scribe job, so note edits do not reset it.
Preserve this file across deployments and use the same exclusive worker lock.
Counts start when this feature is enabled; historical audit failures are not
imported into the budget.

On the third failure, the writer first sets `retry_failed=true` and validates the
returned job/export. It then sets `written_back=true` and records local retirement.
The failed record leaves the queue, allowing subsequent records to proceed. With
a one-record request, the next job is fetched on the next scheduled invocation.
Both flags being true means retries were exhausted; it does not mean the EHR draft
was successfully written. Retired jobs never receive successful verification proof.

If either RPC fails, the exhausted job retries only the retirement RPCs on a later
run, always failure flag first. It never spends another EHR attempt. Successfully
verified drafts recover acknowledgement separately and are not flagged as failed
because their acknowledgement RPC was unavailable. Browser startup, explicit
authentication failures, and source-load validation failures do not consume the
clinical retry budget. Probe, file input, and `--no-acknowledge` do not count attempts
or retire jobs.

The summary's `failed` count is unresolved records; `retryFailed` is records retired
as failures during that invocation. Either count makes the worker exit with status
1, so a retired failure remains visible in cron logs. A resolved page can advance
its cursor even when it includes retired failures. Local retirement also prevents
stale responses from replaying exhausted jobs. Any deliberate manual requeue must
reconcile both upstream flags and the corresponding local retry state while the
worker is stopped.

## Response fields

The adapter accepts one object or an array of at most 100 objects, with a 10 MiB
input limit. Use `care1960.recordsPath` for a nested result and `care1960.fields`
to map field names. See [API configuration and mapping](docs/CARE1960_INTEGRATION.md)
and [the synthetic response](config/care1960-response.example.json).

Migration `0010` returns a root array that matches the default field mappings:
`note.hpi`, `note.ros`, and `note.physical_examination`, with patient, encounter,
and attestation metadata. Use `recordsPath: ""` and `fields: {}`. No eligible
record returns `[]`. The earlier appointment-upsert and HPI-only export APIs
remain separate and cannot supply this writer's clinical input.

The fetch RPC filters `written_back=false` server-side, so `written_back` is
not required in its response. If supplied, it must be `false`. This does not
change the separate writeback acknowledgement validation.

The [SQL-generated fixture](test-support/fixtures/README.md) has passed the API
adapter and synthetic Playwright draft/read-back tests. Deployment, credentials,
and the live PrognoCIS canary still require verification.

## Destination behavior

All three section keys and attestation/identity metadata are required. Following
Care1960 migration `0023`, section values may be strings or null, including blank,
heading-only, or placeholder text such as `Not documented`. The writer preserves
supplied text with its existing outer-whitespace trimming and treats null as an
empty narrative. It never fills missing findings with generated text. Missing keys,
non-string/non-null values, and values exceeding 200,000 UTF-16 units are rejected.
An empty source section leaves an empty EHR field untouched; any different existing
EHR text still stops the record, including when the source is blank or a placeholder.
All three resulting fields and draft status must match on read-back before normal
acknowledgement. Physical assessment maps to Physical Examination, never the
separate Assessment section. No diagnosis
codes, symptom checkboxes, signing, finalization, or claims actions are performed.
Existing different text stops the record. Existing identical text is a no-op.

Before entering HPI, the writer opens the HPI menu and finds the configured
`hpiComplaintName` (`Wellness exam`). With the captured encounter-list selectors,
it matches the exact complaint name, binds its checkbox to the same row's stable
ID, activates the narrative by clicking the name, and ensures that row's
chief-complaint checkbox is checked. Checkbox indexes are not hardcoded, and
other complaint checkboxes are preserved. The lookup is used only when the
complaint is absent. Both the active ID and checkbox are checked again before
filling and saving HPI. Read-back reselects the same complaint to verify the
correct narrative slot. Missing, ambiguous, inactive, or unchecked selection
stops the write. Probe mode never selects a complaint.
See [the Wellness Exam flow](docs/PROGNOCIS_WELLNESS_HPI_FLOW.md).

Draft writes retain the existing configuration gate:

```dotenv
CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES
```

PrognoCIS uses the authenticated Chrome session through localhost CDP, with
noVNC available for login/MFA. Run one configured probe and a supervised draft
canary before scheduling. See [readiness](LIVE_READINESS_CHECKLIST.md),
[architecture](docs/ARCHITECTURE.md), and the
[full Hermes production cron runbook](docs/HERMES_PRODUCTION_CRON_RUNBOOK.md).
