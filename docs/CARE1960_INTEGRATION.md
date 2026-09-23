# Care1960 API input

The CLI exclusively uses `src/integrations/care1960-api.mjs`. It either reads a
captured POST response or issues one POST with the configured request body.
Playwright is used only for the PrognoCIS destination.

For the backend handoff, see [API response requirements](CARE1960_API_REQUIREMENTS.md),
including the required JSON example, field rules, and acceptance criteria.

## Endpoint and request

After applying Care1960 migration `0010` to the intended backend, use:

```text
POST http://127.0.0.1:54321/rest/v1/rpc/care1960_get_attested_clinical_records
```

For another instance, replace the base URL. Set `SUPABASE_ANON_KEY` to that
instance's gateway anon key and `SUPABASE_TENANT_API_KEY` to its registered, live
Care1960 tenant API JWT. Both are required; the tenant token is separate from
the gateway key. The RPC derives the organization from authenticated claims.

Copy [the request example](../config/care1960-request.example.json) into the
private runtime directory and replace the identifiers. The patient and encounter
filters must be provided together. The optional job UUID selects one exact
attested job, including when combined with those filters. Use `p_limit: 1` for
the first canary.

## Configuration

| Setting | Meaning |
|---|---|
| `care1960.input` | `response-file` or `http` |
| `care1960.responseFile` | Private captured response JSON file |
| `care1960.apiUrl` | Exact POST URL; HTTPS or loopback HTTP |
| `care1960.requestFile` | Private JSON object sent as the POST body |
| `care1960.timeoutMs` | HTTP timeout, including response-body reading; 1–60000 ms |
| `care1960.orgId` | Expected organization UUID, checked on every record |
| `care1960.recordsPath` | Dot-separated path to one record or an array; empty means response root |
| `care1960.fields` | Overrides of the default field paths below |

Paths are resolved relative to each selected record. Numeric path segments can
select an array element. Overrides select fields, not literal fallback values.
The source does not invent attestation, identity, or clinical findings.

| Field | Default path |
|---|---|
| `orgId` | `org_id` |
| `jobId` | `scribe_job_id` |
| `status` | `status` (must be `ATTESTED`) |
| `patientId` | `patient.prognocis_patient_id` |
| `firstName` | `patient.first_name` |
| `lastName` | `patient.last_name` |
| `dob` | `patient.date_of_birth` |
| `appointmentId` | `appointment.prognocis_appointment_id` |
| `encounterId` | `appointment.prognocis_encounter_id` |
| `startTime` | `appointment.starts_at` |
| `appointmentType` | `appointment.appointment_type` |
| `providerName` | `appointment.provider_name` (optional value) |
| `attestedAt` | `attestation.attested_at` |
| `attestedBy` | `attestation.attested_by` |
| `hpi` | `note.hpi` |
| `ros` | `note.ros` |
| `physicalExamination` | `note.physical_examination` |

Migration `0010` returns a root array with these exact field names. Leave
`recordsPath` empty and `fields` as `{}` for this RPC. For another response with
`data` containing records whose note uses database column
names, configure:

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

The remaining default fields still apply. The illustrative single-record sample
at `config/care1960-response.example.json` is synthetic. The fixture at
`test-support/fixtures/care1960-0010-response.json` is an actual SQL function
result from synthetic records in an isolated database; it preserves the RPC's
array shape, microsecond timestamps, and extra attestation provenance fields.

## Backend contract found in the sibling application

In `../1960pacare/Supabase_Applications/care1960`, migration
`0010_care1960_attested_clinical_api.sql` implements the clinical read RPC.
It reads all three sections from `attestation.note_version`, checks the complete
reviewed note's hash and frozen identity/attestation proof, and excludes
incomplete or changed records. It returns `[]` when no eligible record exists.

The RPC is read-only, including for POST. It does not update appointments or
mark an export delivered. Migration `0005`'s appointment-upsert response is
still sync metadata; migration `0008`'s frozen export remains HPI-only.

All 67 checks in the backend SQL test passed in an isolated database. Its
SQL-generated response passed the writer's API and synthetic Playwright tests.
This verifies the checked-in contract, not deployment to the intended Supabase
instance. No sibling backend files or deployed services were changed.

## Batches and pagination

The RPC accepts `p_limit` from 1 to 100, optional `p_attested_since`, and the
paired cursor fields `p_after_attested_at` and `p_after_scribe_job_id`. Results
sort by attestation time and job ID; `X-Care1960-Has-More` reports another page.
The response is marked `Cache-Control: no-store`.

The writer consumes one response per invocation and does not act on the
pagination header or persist a cursor. A fixed first-page body keeps returning
the same records; the local ledger skips verified content without advancing
the API. Use an exact-job request until a scheduling wrapper manages page
progress. Keep the API limit within the writer's run limit and advance only
after reconciling every result, including failed or ambiguous writes. This API
is not an unsent-record queue.

## Verification semantics

The in-memory version 3 artifact includes the three narratives, attestation, and
patient/encounter metadata. Its local SHA-256 hash includes a tenant-qualified
job ID. This hash detects changed content and supports the existing local ledger;
it is not a verification of a server-provided `canonical_payload` signature/hash.
The extra `attestation.note_version` and `attestation.note_hash` are accepted
but not used in the local artifact. Source proof is checked by the SQL function;
the writer does not recompute the server's complete six-section note hash.

File input is reread before writing and after destination verification. HTTP
input is captured once and rechecked against that snapshot. The POST is never
replayed as a source check. Upstream revocation/freshness checks and Supabase
export acknowledgements require a separately specified read/ack contract and
are not represented as implemented.

A source exception contains a controlled error code/message, never the upstream
response body, credentials, patient names, or narrative content. File input and
HTTP responses are capped at 10 MiB. The entire selected batch is validated
before any record can reach the destination, and duplicate job IDs are rejected.
