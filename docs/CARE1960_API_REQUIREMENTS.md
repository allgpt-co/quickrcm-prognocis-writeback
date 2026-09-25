# Care1960 clinical API response requirements

## Purpose

Provide the provider-attested HPI, ROS, and Physical Examination for a specific
patient and encounter. The writeback script consumes this API response, then
uses Playwright to enter the three narratives into the matching PrognoCIS
encounter and verify the saved draft.

This contract is now implemented by Care1960 migration `0010`. The SQL output
has been verified against the writer's adapter and synthetic Playwright draft
flow. Applying the migration to the intended Supabase instance and verifying a
live destination canary remain deployment steps.

## Implemented endpoint

Migration `0010_care1960_attested_clinical_api.sql` in
`1960pacare/Supabase_Applications/care1960/supabase/migrations` provides:

```text
POST http://127.0.0.1:54321/rest/v1/rpc/care1960_get_attested_clinical_records
```

Use the intended instance's base URL after applying the migration there. The
function is read-only: it returns the three narratives from the exact attested
note version without changing appointments or export state.

The older `care1960_upsert_prognocis_appointment` RPC remains an inbound sync API
that returns sync metadata. The migration `0008` export remains HPI-only. Use
the new clinical read RPC for this writer.

## Request and authentication

Use [the exact-job request example](../config/care1960-request.example.json),
replacing all synthetic identifiers with actual original EHR IDs and the
clinical job UUID. Store it privately as `.runtime/care1960-request.json`.

| Parameter | Rules |
|---|---|
| `p_prognocis_patient_id` | Optional nonblank original EHR ID, up to 200 UTF-16 units; requires encounter filter. |
| `p_prognocis_encounter_id` | Optional nonblank original EHR ID, up to 200 UTF-16 units; requires patient filter. |
| `p_scribe_job_id` | Optional job UUID; usable alone or ANDed with the patient/encounter pair. |
| `p_limit` | Integer 1–100, default 1; null is invalid. Use 1 for the canary. |
| `p_attested_since` | Optional inclusive lower bound on attestation time; send a finite timestamp with timezone. |
| `p_after_attested_at` | Optional timestamp cursor; requires job cursor. |
| `p_after_scribe_job_id` | Optional UUID cursor; requires timestamp cursor. |

A patient/encounter pair matching multiple eligible jobs fails; select the exact
job UUID. The organization is derived from verified credentials, not a body field.

Both private environment variables are required:

- `SUPABASE_ANON_KEY`: the intended Supabase instance's anon gateway key, sent
  as `apikey`.
- `SUPABASE_TENANT_API_KEY`: a registered, live Care1960 tenant API JWT from that
  same instance, sent as `Authorization: Bearer ...`.

There is no fallback between credentials. Human doctor tokens and unscoped
service-role keys are not the tenant credential for this RPC.

## Required success response

The RPC returns HTTP `200` with `Content-Type: application/json`,
`Cache-Control: no-store`, and a root array, including for a single record.
The example below uses synthetic values.

```json
[
  {
    "org_id": "11111111-1111-4111-8111-111111111111",
    "scribe_job_id": "22222222-2222-4222-8222-222222222222",
    "status": "ATTESTED",
    "patient": {
      "prognocis_patient_id": "ehr-patient-123",
      "first_name": "Sample",
      "last_name": "Patient",
      "date_of_birth": "1980-01-02"
    },
    "appointment": {
      "prognocis_appointment_id": "ehr-appointment-456",
      "prognocis_encounter_id": "ehr-encounter-789",
      "starts_at": "2026-09-16T10:30:00-05:00",
      "appointment_type": "Follow Up",
      "provider_name": "Dr Example"
    },
    "attestation": {
      "attested_at": "2026-09-16T11:00:00-05:00",
      "attested_by": "33333333-3333-4333-8333-333333333333"
    },
    "note": {
      "hpi": "Patient reports an improving cough.",
      "ros": "Reports cough. Denies fever or chills.",
      "physical_examination": "Lungs clear to auscultation."
    }
  }
]
```

Return `[]` when there are no eligible attested records. The current adapter
also accepts a single object for captured input. It accepts at most 100 records
and a total response size of 10 MiB. Duplicate clinical job IDs within one
organization are rejected.

The RPC also includes `attestation.note_version` and `attestation.note_hash`
as provenance. These extra fields are accepted by the writer; it does not use
them to recompute the server's full-note hash. The SQL-generated fixture at
`test-support/fixtures/care1960-0010-response.json` includes those actual values
from synthetic records.

## Field requirements

All fields below are required except `appointment.provider_name`. Text limits
are measured in UTF-16 units to match JavaScript validation.

| JSON field | Type and limit | Meaning |
|---|---|---|
| `org_id` | UUID string | Authorized Care1960 organization; must match the writer's configured organization. |
| `scribe_job_id` | Non-empty string, up to 100 characters | Stable Care1960 clinical job ID; return the job's UUID. |
| `status` | String, exactly `ATTESTED` | The clinical note has completed provider attestation. |
| `patient.prognocis_patient_id` | Non-empty string, up to 200 characters | Original PrognoCIS patient ID. |
| `patient.first_name` | Non-empty string, up to 200 characters | Patient's first name for EHR matching. |
| `patient.last_name` | Non-empty string, up to 200 characters | Patient's last name for EHR matching. |
| `patient.date_of_birth` | Valid date string, `YYYY-MM-DD` | Patient's date of birth. |
| `appointment.prognocis_appointment_id` | Non-empty string, up to 200 characters | Original PrognoCIS appointment ID. |
| `appointment.prognocis_encounter_id` | Non-empty string, up to 200 characters | Exact PrognoCIS encounter receiving the note. |
| `appointment.starts_at` | ISO 8601 timestamp with timezone | Appointment start; the writer derives the service date in its configured timezone. |
| `appointment.appointment_type` | Non-empty string, up to 300 characters | Appointment type matching the PrognoCIS encounter. |
| `appointment.provider_name` | Optional string, up to 300 characters | Provider name matching PrognoCIS; omit or use `null` if unavailable. |
| `attestation.attested_at` | ISO 8601 timestamp with timezone | Actual time of provider attestation. |
| `attestation.attested_by` | Non-empty string, up to 100 characters | Stable ID of the user who attested the note. |
| `note.hpi` | Required key; string up to 200,000 UTF-16 units or null | Attested History of Present Illness narrative; may be blank or placeholder text. |
| `note.ros` | Required key; string up to 200,000 UTF-16 units or null | Attested Review of Systems narrative; may be blank or placeholder text. |
| `note.physical_examination` | Required key; string up to 200,000 UTF-16 units or null | Attested Physical Examination narrative; may be blank or placeholder text. |

Do not substitute Supabase patient or appointment UUIDs for the corresponding
`prognocis_*` identifiers. Do not fabricate missing encounter IDs or attestation
details. Example IDs in this document must be replaced with actual record IDs.

Timestamps may use UTC (`2026-09-16T15:30:00Z`) or an explicit offset
(`2026-09-16T10:30:00-05:00`). Timestamps without a timezone are rejected.

## Clinical content and source consistency

1. Return all three sections from the same provider-attested note version.
2. Read the version referenced by the attestation. Do not combine attested HPI
   with ROS or an examination from a newer, unreviewed note.
3. Patient, appointment, encounter, job, and attestation must belong to the same
   clinical record and authorized organization.
4. Return the reviewed text without generating findings or converting missing
   information into normal findings. Following migration `0023`, null, blank,
   heading-only, and placeholder-only sections such as `Not documented` are
   accepted. Null becomes an empty narrative and outer whitespace is trimmed;
   placeholder wording is preserved. Empty source sections never erase existing
   destination text; different existing text remains a conflict.
5. `status` describes clinical attestation. An appointment sync result such as
   `CREATED`, or an export queue status such as `READY`, does not replace it.
6. An existing frozen `HPI_NARRATIVE` export cannot be presented as proof of a
   three-section export. Migration `0010` preserves this association by checking
   the full rendered note/hash against the frozen note version, hash, identity,
   and attestation proof. Attestations without that proof are excluded.

The corresponding Care1960 note columns are:

| Care1960 note column | API field | PrognoCIS destination |
|---|---|---|
| `hpi_text` | `note.hpi` | HPI narrative field |
| `ros_text` | `note.ros` | ROS narrative field |
| `physical_exam_text` | `note.physical_examination` | Physical Examination narrative field |

“Physical assessment” means Physical Examination in this integration. The
separate Assessment and Plan sections, diagnosis codes, and structured symptom
controls are outside the requested write scope.

## Alternative field names and response envelopes

Migration `0010` matches the writer's defaults: use `recordsPath: ""` and
`fields: {}`. The writer also supports configured JSON paths for other APIs.
For example, if the response wraps records in `data` and uses database column
names inside `note`,
set these properties within `care1960` in the writer configuration:

```json
{
  "recordsPath": "data",
  "fields": {
    "hpi": "note.hpi_text",
    "ros": "note.ros_text",
    "physicalExamination": "note.physical_exam_text"
  }
}
```

Mappings select existing response values; they do not supply missing values.

## Deployment and batch handling

Deployment still needs the actual backend base URL, migration application,
private credentials, organization UUID, and patient/encounter/job identifiers.
Capture the deployed response and run response validation before opening the
destination. An exact-job read returns `[]` if the record is ineligible, including
when required IDs, sections, or attested-version proof are missing.

The API sorts by `(attested_at, scribe_job_id)` and returns
`X-Care1960-Has-More`. The writer does not paginate or advance a watermark.
A fixed first-page request repeatedly returns the same records. Use the exact-job
request until a scheduler persists a cursor and reconciles every page's results
before advancing, without skipping failed or ambiguous writes. Keep `p_limit`
within the writer's per-run limit. This API is not an unsent-record queue.

The writer sends one POST per invocation and does not repeat it during EHR
verification. HTTP mode validates the captured response; it does not verify
subsequent upstream changes. Writer-side server canonical-hash verification,
export leasing, and Supabase completion acknowledgement are not implemented.
The local content hash and ledger track the writer's verified destination result.

## Acceptance criteria

- The actual endpoint returns all required fields from one attested note version.
- An ineligible or absent record returns `[]` without invented findings or writes.
- A captured response passes `npm run validate:response` using the actual
  organization and configured JSON paths.
- Responses missing any clinical section key, attestation, or required patient
  identity metadata are rejected before the writer opens PrognoCIS. Explicit null
  or blank section values are accepted. An optional PrognoCIS encounter ID may be
  null; the destination still requires an unambiguous encounter match.
- A configured probe selects exactly one matching patient and encounter.
- A supervised draft write saves HPI, ROS, and Physical Examination into their
  respective fields and verifies them after reopening the encounter.
- Existing different text stops the write; replaying the same verified response
  produces no additional writes.

Validate a captured response without opening a browser:

```bash
npm run validate:response -- --config config/writeback.json \
  --response .runtime/care1960-response.json
```

Set `care1960.orgId` to the response's actual organization before running this
command. All 67 SQL checks passed in an isolated database, and a response from
that function passed the adapter and synthetic Playwright save/reopen tests.
These tests do not establish compatibility with deployed credentials or the
live destination; release acceptance requires its response and a destination canary.

See [Care1960 integration configuration](CARE1960_INTEGRATION.md) for the complete
mapping and transport settings.
