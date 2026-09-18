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

Both credentials are required in `.env`: `CARE1960_API_KEY` supplies the Supabase
instance's gateway anon key in `apikey`; `CARE1960_BEARER_TOKEN` supplies a
registered, live Care1960 tenant API JWT in `Authorization`. Use credentials
from the same backend instance. There is no fallback between the two.

Each invocation sends the POST once and consumes that response. It does not
retry timeouts, follow redirects, or repeat the POST during writeback checks.
`validate:response` and `probe` also send the POST in HTTP mode. This clinical
RPC reads attested records without updating appointment or export state.

The file source is reread before/after EHR writes. HTTP mode checks the captured
response; it does not query current upstream state or acknowledge an export to
Supabase. Completion proof is local to this writer.

Use an exact-job request for the first canary. The writer does not advance the
API's pagination cursor. A fixed first-page request repeatedly returns the same
records, even after the local ledger verifies them. Keep `p_limit` within the
writer's record limit; a batch scheduler must reconcile each page's results
before advancing its cursor.

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

All three sections, attestation, and retained PrognoCIS patient/encounter IDs are
required. Missing or placeholder-only findings are rejected. Physical assessment
maps to Physical Examination, never the separate Assessment section. No diagnosis
codes, symptom checkboxes, signing, finalization, or claims actions are performed.
Existing different text stops the record. Existing identical text is a no-op.

Before entering HPI, the writer opens the HPI menu, searches the complaint
lookup for the configured `hpiComplaintName` (`Wellness exam`), selects only one
exact matching row, and verifies its active complaint ID. The checkbox is
checked rather than toggled. The same active ID is checked again immediately
before filling HPI and before saving it. Read-back reselects the same complaint
to verify the correct HPI narrative slot. Missing, ambiguous, or inactive
complaint selection stops the write. Probe mode never selects a complaint.
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
