# Second cron: configured production API and sample input

The Care1960-to-PrognoCIS writeback worker is configured to use:

```text
POST https://supabase-api.quickintell.com/rest/v1/rpc/care1960_get_attested_clinical_records
```

The cron wrapper runs `node src/cli.mjs run --config config/writeback.json`.
With `care1960.input: "http"`, the worker sends one POST using the JSON body
from `.runtime/care1960-request.json`. This identifies the configured API;
it does not confirm that the production cron is activated. Writes currently
remain disabled pending private setup and the approved supervised canary.

## Sample input: one exact attested job

This UUID is synthetic. Replace it privately with the actual production
Care1960 scribe-job UUID in `.runtime/care1960-request.json`:

```json
{
  "p_scribe_job_id": "22222222-2222-4222-8222-222222222222",
  "p_limit": 1
}
```

If the original PrognoCIS patient and encounter IDs are known, optionally
include both. All identifiers below are synthetic:

```json
{
  "p_prognocis_patient_id": "synthetic-patient-1",
  "p_prognocis_encounter_id": "synthetic-encounter-1",
  "p_scribe_job_id": "22222222-2222-4222-8222-222222222222",
  "p_limit": 1
}
```

Patient and encounter filters must be supplied together. Use original EHR IDs,
not Supabase patient/appointment UUIDs. The organization is authorized by the
tenant JWT, not selected by the request body.

## Required request headers

```text
Content-Type: application/json
apikey: <production Supabase gateway anon key>
Authorization: Bearer <registered production Care1960 tenant JWT>
```

The worker loads `CARE1960_API_KEY` and `CARE1960_BEARER_TOKEN` from its private
repository `.env` or process environment. Both must belong to the same production
instance. Never place real credentials, patient information, or production IDs
in this document, chat, Git, or logs.

## Returned data and destination

The response is an array containing original PrognoCIS identities, attestation
metadata, and `note.hpi`, `note.ros`, and `note.physical_examination`.
No eligible matching record returns `[]`.

Playwright opens the exact PrognoCIS patient/encounter. HPI is the main target:
it saves to the HPI narrative field as a draft and verifies after reopening
before ROS and Physical Examination are attempted independently. Optional-section
failures are reported without invalidating verified HPI. Different existing
HPI stops safely; no encounter is signed or finalized.

This RPC is read-only, is not an appointment-upsert API, and creates no queue.
Migration `0010` is already applied in production; do not rerun it. The worker
does not paginate automatically. Start with the exact-job request above.

See [the production runbook](docs/PRODUCTION_SECOND_CRON.md) for private setup,
validation, the supervised canary, and scheduling limitations.

---

The earlier architecture plan below is retained for reference; the API summary
above describes the current configured writeback flow.

# 1960PA Care Dedicated Scribe Application

## Architecture and implementation plan

**Prepared from the current repositories on September 14, 2026.**

## 1. The short answer

Do **not** copy the whole `rcm_v2` application. It contains hundreds of RCM, billing, claims, coding, and administration models that 1960PA Care does not need.

Build a small application called, for example, **1960PA Scribe**, with only this path:

```text
PrognoCIS appointment
        |
        | inbound Hermes sync
        v
Supabase patient + appointment
        |
        | doctor records/uploads audio
        v
Transcript -> generated note -> coding review -> attestation
        |
        | outbound Hermes sync every 5 minutes
        v
Verified draft in the exact PrognoCIS encounter
```

The recommended ownership is:

- **PrognoCIS** is the source of truth for the original patient, appointment, provider, and encounter identity.
- **Supabase** is the source of truth for the dedicated scribe workflow, audio metadata, transcript, note versions, coding review, attestation, and export state.
- **Hermes** runs both integration workers.
- **The browser frontend** only shows the small workflow the clinicians need.

The new application should live in the existing `Supabase_Applications` repository. The existing `quickrcm-prognocis-writeback` repository should remain the PrognoCIS automation worker and be adapted to read attested artifacts from Supabase instead of scraping the old QuickRCM UI.

---

## 2. What the current `quickrcm-prognocis-writeback` repository contains

This repository is **not** the RCM, not a patient database, and not a frontend. It is the reverse integration worker that transfers a reviewed clinical draft from QuickRCM/QuickScribe into PrognoCIS.

### Main areas

| Path | Responsibility |
|---|---|
| `src/browser/session.mjs` | Connects Playwright to the already-open authenticated Chrome through CDP. |
| `src/browser/locators.mjs` | Safe helpers for finding and interacting with elements, including iframe-aware searches. |
| `src/integrations/quickscribe-browser.mjs` | Reads an attested scribe record from the old QuickRCM UI. This is the part we will eventually replace with a Supabase source adapter. |
| `src/integrations/prognocis-browser.mjs` | Finds the exact patient and encounter in PrognoCIS, writes draft sections/codes, saves, reopens, and verifies them. This remains valuable. |
| `src/domain/build-export-artifact.mjs` | Converts the final note into the supported clinical sections. |
| `src/domain/clinical-artifact.mjs` | Validates the data contract and creates the deterministic artifact hash. |
| `src/domain/matching.mjs` | Performs strict patient and encounter matching. |
| `src/workflow/writeback.mjs` | Orchestrates revalidation, matching, write, verification, and acknowledgement. |
| `src/runtime/config.mjs` | Validates configuration and enforces the explicit live-write acknowledgement. |
| `src/runtime/lock.mjs` | Prevents two copies of the worker from writing simultaneously. |
| `src/runtime/ledger.mjs` | Stores PHI-free proof that an artifact was verified in PrognoCIS. |
| `src/runtime/audit.mjs` | Writes restricted, PHI-free execution events. |
| `scripts/install-hermes-cron.sh` | Installs the five-minute Hermes job. |
| `test/` | Tests parsing, validation, matching, browser safety, ledger behavior, and writeback orchestration. |

### Its current safety boundary

The reverse worker currently:

1. accepts only an attested note;
2. includes only the permitted clinical sections and reviewed codes;
3. resolves one exact patient and one exact encounter;
4. writes only an editable/open draft;
5. never signs/finalizes the EHR encounter;
6. refuses to overwrite different non-empty text;
7. reopens and verifies the destination;
8. records a hash acknowledgement so a retry becomes idempotent.

These protections should be preserved. The new frontend/database changes **where the source data comes from**, not how carefully PrognoCIS is written.

### What is not in this repository

The six PrognoCIS-to-QuickRCM scripts are not stored here. They are deployed with the existing Hermes/PrognoCIS VOB automation. Their destination currently calls QuickRCM APIs. For the new application, their extraction and normalization logic can remain, but the destination adapter must upsert into Supabase.

---

## 3. What to reuse from `rcm_v2`

`rcm_v2` is a Wasp/React/Prisma/Postgres product with roughly 339 Prisma models. We should treat it as a **domain and UX reference**, not copy it wholesale.

The useful concepts are:

- `Organization`, `User`, and `OrganizationMember` for tenancy and roles;
- `Patient` and `Appointment`, with retained EHR identifiers;
- `ScribeTemplate`;
- `ScribeJob` and its processing status;
- `ScribeNoteVersion` for edit history;
- coding suggestions plus explicit human acceptance/rejection;
- provider attestation;
- a stable clinical export artifact and hash;
- an acknowledgement only after the destination draft is verified.

The important reference files are:

```text
../rcm_v2/rcm_v2/schema.prisma
../rcm_v2/rcm_v2/src/rcm/scribe/encounter/operations.ts
../rcm_v2/rcm_v2/src/rcm/scribe/workers/processJob.ts
../rcm_v2/rcm_v2/src/rcm/scribe/workers/jobProcessors.ts
../rcm_v2/rcm_v2/src/rcm/scribe/clinicalExport.ts
../rcm_v2/rcm_v2/src/rcm/scribe/clinicalExportApi.ts
```

The existing RCM flow uses a background queue, Deepgram for transcription, and AWS Bedrock for note generation. That logic can be extracted into a small worker, but it should not bring billing, credits, claims, CDI dashboards, insurance, or the rest of the RCM into the new product.

One improvement over the existing RCM is essential: the inbound sync should save the PrognoCIS patient, appointment, encounter, and provider identifiers directly in Supabase. The reverse worker must not depend on a manually maintained `appointmentIdByJobId` mapping.

---

## 4. Correct meaning of “root” and “tenant” in this Supabase platform

Your senior's description is directionally correct, but the names are easy to misunderstand.

### The existing platform does not use one Postgres schema per tenant

The canonical design in:

```text
../1960pacare/Supabase_Applications/architecture.md
../1960pacare/Supabase_Applications/supabase-multi-tenant-guide.md
```

uses one self-hosted Supabase project and the shared `public` schema.

There are two logical layers:

### A. Platform/control-plane layer — what was called “root”

- `auth.users`: Supabase's private Auth identities.
- `public.clients`: which client application the data belongs to.
- `public.orgs`: the practice/tenant underneath the client.
- `public.memberships`: which Auth user belongs to which organization and with what role.
- `public.service_api_keys`: individually revocable, organization-scoped service credentials.

Do **not** create a second “root users” table containing passwords. Supabase Auth owns credentials in `auth.users`. `memberships` supplies application access.

### B. Domain/data-plane layer — the 1960PA Care data

Patients, appointments, scribe jobs, note versions, coding reviews, and exports also live in `public`, but every row has:

```sql
org_id uuid not null references public.orgs(id)
```

Every exposed table has Row Level Security (RLS). RLS checks `auth.uid()` against `public.memberships`, so users only receive rows for their organization.

### The recommended 1960PA records

```text
public.clients
  slug = 1960pacare
  name = 1960PA Care

public.orgs
  client_id = the client row above
  name = 1960PA Care

auth.users
  one record per doctor/staff login

public.memberships
  user_id + the 1960PA Care org_id + role
```

Although the client slug may be `1960pacare`, an ordinary unquoted SQL table name cannot start with a digit. Use a safe prefix such as `care1960_` for domain tables instead of quoted names such as `"1960pacare_patients"`.

Therefore:

- tenant/client slug: `1960pacare`;
- organization: `1960PA Care`;
- SQL prefix: `care1960_`;
- application folder: `1960pacare/` is acceptable;
- RLS, not the table prefix, is the true security boundary.

Supabase Auth issues and manages each user's JWT; the Supabase client automatically sends that token with data requests. RLS then makes the row-by-row authorization decision. See the official [Supabase Auth overview](https://supabase.com/docs/guides/auth) and [Row Level Security guide](https://supabase.com/docs/guides/database/postgres/row-level-security).

---

## 5. Target architecture

```text
                         HUMAN USERS
                              |
                   1960PA Scribe React app
                              |
         anon key + signed-in user's Supabase Auth JWT
                              |
     +------------------------+-------------------------+
     |                        |                         |
Supabase Auth          PostgREST/RPC              Supabase Storage
 auth.users             public tables             private audio bucket
     |                   protected by RLS          protected by RLS
     |                        |
     +---------- memberships/org_id -------------------+
                              |
                      durable work queues
                       /              \
             Scribe processing      clinical exports
                    worker                worker
        Deepgram -> note -> codes          |
                                           | Playwright/CDP
                                           v
                                      PrognoCIS draft

PrognoCIS appointments
        |
        | existing inbound Hermes extractor
        v
Supabase patient/appointment upserts
```

### Deployable parts

1. **Static React frontend** — Vite + Refine + Ant Design, hosted through the existing S3/CloudFront client deployment.
2. **Supabase database/Auth/Storage/Realtime** — the existing self-hosted Supabase stack.
3. **Short authenticated functions/RPCs** — validate state transitions and enqueue work.
4. **Scribe worker** — long-running audio/transcription/note/coding work, deployed as a backend service.
5. **Inbound Hermes worker** — PrognoCIS appointments to Supabase.
6. **Outbound Hermes worker** — Supabase attested artifacts to PrognoCIS drafts.

---

## 6. Minimal database required for 1960PA Care

Do not reproduce the full Prisma schema. The MVP needs the following tables.

### 6.1 `care1960_patients`

Purpose: the minimal patient identity needed to display the schedule and match PrognoCIS safely.

Important columns:

```text
id uuid primary key
org_id uuid not null
prognocis_patient_id text not null
mrn text null
first_name text not null
last_name text not null
date_of_birth date not null
sex text null
active boolean default true
source_updated_at timestamptz null
last_synced_at timestamptz not null
created_at / updated_at timestamptz
```

Required uniqueness:

```text
unique (org_id, prognocis_patient_id)
unique (org_id, mrn) where mrn is not null
```

Do not use name/DOB as the database identity. Those are verification fields; the retained PrognoCIS ID is the integration identity.

### 6.2 `care1960_appointments`

Purpose: the clinician's work list and the hub connecting patient, scribe job, and exact EHR encounter.

Important columns:

```text
id uuid primary key
org_id uuid not null
patient_id uuid not null
prognocis_appointment_id text not null
prognocis_encounter_id text null
prognocis_provider_id text null
provider_name text null
appointment_type text null
starts_at / ends_at timestamptz
appointment_status text
source_hash text null
source_updated_at / last_synced_at timestamptz
created_at / updated_at timestamptz
```

Required uniqueness/indexes:

```text
unique (org_id, prognocis_appointment_id)
unique (org_id, prognocis_encounter_id) where encounter ID is not null
index (org_id, starts_at)
index (org_id, appointment_status, starts_at)
```

The inbound sync performs an idempotent upsert on `(org_id, prognocis_appointment_id)`.

### 6.3 `care1960_scribe_templates`

Purpose: the prompt/section structure used for the generated note.

Important columns:

```text
id, org_id, name, structure_prompt, specialty, language
is_default, active, created_by, created_at, updated_at
```

Seed one tested default template for 1960PA Care. Admins may manage it later; clinicians should not need to choose among many confusing templates in the MVP.

### 6.4 `care1960_scribe_jobs`

Purpose: one recording and processing lifecycle for an appointment.

Important columns:

```text
id uuid primary key
org_id uuid not null
appointment_id uuid not null
patient_id uuid not null
provider_user_id uuid not null
template_id uuid not null
status text not null
audio_object_path text null
audio_duration_seconds integer null
raw_transcript text null
current_note_version integer null
failure_code text null
failure_detail_safe text null
processing_attempts integer default 0
created_at / updated_at / processing_started_at / completed_at
```

Recommended statuses:

```text
RECORDING
UPLOADING
QUEUED
TRANSCRIBING
GENERATING_NOTE
READY_FOR_REVIEW
ATTESTED
EXPORTING
EXPORTED
FAILED
```

Use `READY_FOR_REVIEW`, not an ambiguous `COMPLETED`, for a machine-generated note that still requires the doctor.

Prevent two simultaneous active jobs for the same appointment with a partial unique index. A transaction/RPC must create or reuse the active job instead of relying on a frontend “check then insert.”

### 6.5 `care1960_scribe_note_versions`

Purpose: append-only history of generated and doctor-edited notes.

Important columns:

```text
id, org_id, scribe_job_id, version
hpi_text
ros_text
physical_exam_text
assessment_text
plan_text
rendered_note
note_hash
source = GENERATED or CLINICIAN_EDIT
edited_by, created_at
unique (scribe_job_id, version)
```

Storing HPI, ROS, and Physical Examination explicitly is better than parsing a long free-form note during export. Keep `rendered_note` for display and preserve the explicit sections for PrognoCIS.

### 6.6 `care1960_coding_suggestions`

Purpose: machine-suggested codes and the clinician's actual review decision.

Important columns:

```text
id, org_id, scribe_job_id
code_system, code, description
review_status = SUGGESTED | ACCEPTED | REJECTED
reviewed_by, reviewed_at, created_at
unique (scribe_job_id, code_system, code)
```

For the current live-tested phase, send **accepted ICD-10-CM diagnoses only** to PrognoCIS. Do not silently export every model suggestion. CPT/HCPCS can remain visible or be added later only after their exact destination workflow has been separately tested.

### 6.7 `care1960_attestations`

Purpose: immutable proof of which exact note and accepted codes the provider approved.

Important columns:

```text
id, org_id, scribe_job_id unique
note_version
artifact_hash
attestation_statement_version
attested_by
attested_at
```

Attestation must be an atomic database RPC. It should:

1. verify the caller belongs to the organization;
2. verify the job is `READY_FOR_REVIEW`;
3. verify the submitted version is still current;
4. require the permitted reviewed code set;
5. calculate/store the canonical artifact hash;
6. insert the immutable attestation;
7. set the job to `ATTESTED`;
8. insert the export queue row in the same transaction.

This closes the race where a note changes between review and attestation.

### 6.8 `care1960_clinical_exports`

Purpose: the durable queue and proof for Supabase-to-PrognoCIS writeback.

Important columns:

```text
id, org_id, scribe_job_id, destination
artifact_hash
status = READY | LEASED | WRITING | VERIFIED | CONFLICT | FAILED
attempt_count, next_attempt_at
leased_by, lease_expires_at
prognocis_encounter_id
verified_at
last_error_code
last_error_safe
created_at / updated_at
unique (org_id, destination, artifact_hash)
```

Do not mark this `VERIFIED` just because a click succeeded. Mark it only after the current reverse worker's reopen/readback verification succeeds.

### 6.9 `care1960_integration_runs` and `care1960_audit_logs`

Purpose: operations, troubleshooting, and accountability without putting PHI in general logs.

Store:

- direction (`PROGNOCIS_INBOUND`, `PROGNOCIS_OUTBOUND`, `SCRIBE_PROCESSING`);
- scheduled/start/end timestamps;
- counts read/created/updated/skipped/failed;
- safe error code;
- acting user/service key ID;
- entity type and internal entity ID;
- artifact hash/destination verification state.

Do **not** log note text, transcript, audio URL, patient name, DOB, or raw external payload to console logs.

### 6.10 Audio storage

The database stores metadata and an object path; the audio bytes belong in a **private Supabase Storage bucket**, for example:

```text
bucket: care1960-clinical-audio
path:   <org_id>/<scribe_job_id>/<random_uuid>.webm
```

Private buckets apply RLS to access, and temporary signed URLs can be created when a worker needs to download an object. See the official [Storage bucket access model](https://supabase.com/docs/guides/storage/buckets/fundamentals) and [Storage access-control guide](https://supabase.com/docs/guides/storage/security/access-control).

Set bucket restrictions for supported audio MIME types and a maximum size. Decide and document the audio-retention period before production.

---

## 7. RLS and authorization rules

Every `care1960_*` table must have:

```sql
alter table public.care1960_<table> enable row level security;
```

Also set explicit Postgres grants. Current Supabase guidance emphasizes that grants decide whether an operation is possible and RLS policies decide which rows it applies to. Do not assume that merely enabling RLS fixes overly broad grants.

### Human users

The basic read policy is organization membership:

```sql
org_id in (
  select org_id
  from public.memberships
  where user_id = (select auth.uid())
)
```

Writes also check role. Existing platform roles are:

- `owner`: team, templates, integrations, and clinical work;
- `admin`: team/templates/integrations and clinical work;
- `member`: normal clinician workflow;
- `viewer`: read-only.

Hiding a button in React is only UX. RLS/RPC validation is the actual security boundary.

### Backend workers

The inbound, scribe-processing, and outbound workers should use an individually revocable organization-scoped token created through `manage-tenant-api-key.mjs`. Each domain table needs additive policies using:

```sql
public.service_api_key_authorized(org_id)
```

Do not use `service_role` for routine cron execution when a tenant-scoped key can do the job.

### Sensitive state transitions

Do not let a browser arbitrarily update these columns through generic CRUD:

- `scribe_jobs.status`;
- `provider_user_id` after creation;
- transcript generated by the worker;
- note version after attestation;
- attestation metadata;
- artifact hash;
- export state/verification.

Revoke direct update privileges for these operations and expose narrow Postgres RPCs or server functions that re-check the caller and expected current version/status.

---

## 8. What APIs Supabase creates automatically

Supabase exposes a PostgREST Data API at `/rest/v1`. Tables, safe views, relationships, and Postgres functions/RPCs are reflected automatically, so ordinary CRUD does not need handwritten Express routes. This can be used directly from the browser together with RLS, or alongside a backend. See the official [Supabase Data REST API documentation](https://supabase.com/docs/guides/api).

For example, the frontend can use `@supabase/supabase-js` for:

```text
sign in                              -> Supabase Auth
list today's appointments            -> care1960_appointments
get the patient for an appointment   -> relation/query
list note versions                   -> care1960_scribe_note_versions
save a clinician edit                -> safe RPC or constrained insert
accept/reject a code                 -> safe RPC or RLS-protected update
attest                               -> care1960_attest_note(...) RPC
upload audio                         -> Supabase Storage
watch job status                     -> Supabase Realtime
```

Supabase does **not** automatically implement business workflows merely because it creates CRUD endpoints.

### Use a database RPC when

- several related rows must change atomically;
- current status/version must be checked;
- the caller's role must be revalidated;
- the result is fast and database-focused.

Examples:

```text
care1960_start_encounter(...)
care1960_save_note_edit(...)
care1960_review_code(...)
care1960_attest_note(...)
care1960_claim_export(...)
care1960_acknowledge_export(...)
```

### Use an Edge Function when

- a short HTTP endpoint must call an external service;
- an invite email must be initiated through Auth Admin;
- a signed upload/download workflow needs extra checks;
- request validation/orchestration does not fit cleanly in SQL.

### Use a durable worker when

- audio transcription may take minutes;
- note generation and coding require retries;
- a browser must automate PrognoCIS;
- the task must survive a request timeout or process restart.

Supabase explicitly recommends moving heavy, long-running jobs out of Edge Functions into background workers. Edge Functions can start background work, but they still have runtime/CPU/memory limits and can be terminated. See [Edge Functions](https://supabase.com/docs/guides/functions), [background tasks](https://supabase.com/docs/guides/functions/background-tasks), and [function limits](https://supabase.com/docs/guides/functions/limits).

Therefore the correct agentic design is:

```text
Frontend/RPC validates and enqueues quickly
                 |
                 v
Durable queue row/message
                 |
                 v
Long-running Coolify/Hermes worker
                 |
                 v
Worker stores status/results back in Supabase
```

The queue can initially be a carefully leased table. Supabase also documents Postgres-native durable queues via `pgmq`; if that extension is enabled on this self-hosted stack, it is a good alternative because messages remain until explicitly removed or archived. See [Supabase Queues](https://supabase.com/docs/guides/queues).

---

## 9. Dedicated frontend scope

Use the existing `texas-retina` app as the scaffold because it already has:

- Vite + React;
- Refine + Ant Design;
- Supabase Auth and Data Provider;
- organization membership rejection after login;
- `owner/admin/member/viewer` UI permissions;
- login, forgot-password, and reset-password pages;
- team administration;
- the repository's S3/CloudFront deployment convention.

Reference:

```text
../1960pacare/Supabase_Applications/texas-retina/
```

### Only these main navigation items

1. **Today**
2. **Appointments**
3. **Encounters**
4. **Templates** — admin only
5. **Team** — owner/admin only
6. **Settings** — minimal; integration health, language, date format, no secrets

Do not include claims, eligibility, denial management, finance, billing, prior authorization, CDI analytics, or the other general RCM navigation.

### Page 1: Login

- Email and password.
- Forgot/reset password.
- After successful Auth login, verify membership under client slug `1960pacare`.
- If there is no membership, sign the user out and show a clear “Your account is not linked to 1960PA Care” message.

### Page 2: Today dashboard

The main dashboard should be a clinical work list, not an analytics-heavy RCM dashboard.

Show:

- today's date and practice timezone;
- scheduled appointment count;
- recordings currently processing;
- notes needing review;
- attested notes waiting for PrognoCIS;
- failed/conflicted items needing attention;
- today's appointments in time order.

The primary visual anchor should be a four-stage workflow rail on every appointment:

```text
Scheduled -> Recording -> Review -> Sent to PrognoCIS
```

This makes the product's single purpose visible without forcing the doctor to understand integration internals.

### Page 3: Appointments

- Default to Today.
- Previous/next day and calendar date selector.
- Search by patient/MRN.
- Filters: scheduled, in progress, review needed, sent, failed.
- Columns/cards: time, patient, appointment type, provider, workflow status, action.
- Primary action: `Start encounter` or `Continue review`.
- Show PrognoCIS sync state in plain language, not raw IDs.

The frontend should not normally create a new appointment because PrognoCIS is the schedule source of truth. A test/admin-only manual appointment tool may exist in non-production, clearly marked synthetic.

### Page 4: Encounter/recording

Header:

- patient name, DOB, appointment time/type, provider;
- compact privacy treatment; no patient names in page title/browser notification.

Recording state:

- large `Start recording`, `Pause`, `Resume`, and `Stop` controls;
- clearly visible elapsed time and input device;
- microphone-permission explanation;
- alternative `Upload existing audio` action;
- explicit confirmation before deleting/restarting a recording.

After Stop:

1. upload audio to the private bucket;
2. finalize the upload through an RPC/function;
3. enqueue the processing job;
4. show `Uploading`, `Transcribing`, and `Generating note` states;
5. disable duplicate submissions while the request is running;
6. provide a safe retry only if the durable job is actually failed.

### Page 5: Note review and attestation

Use tabs or one split workspace:

- **Clinical note** — editable HPI, ROS, Physical Examination, Assessment, Plan;
- **Transcript** — read-only;
- **Audio** — authenticated player using a short-lived URL;
- **Codes** — suggested ICD-10, accept/reject controls;
- **History** — note versions and author/time.

Before attestation, show:

- unsaved-change warning;
- current version indicator;
- accepted code summary;
- exact attestation statement;
- `Attest and queue for PrognoCIS` as the final explicit action.

After attestation:

- note editing is locked;
- state changes to `Waiting for PrognoCIS`;
- finally to `Verified in PrognoCIS` only after destination readback;
- a conflict remains visible for human review and is not silently retried over different text.

### Page 6: Encounters

A searchable history with:

- appointment/patient;
- provider;
- recorded/attested times;
- current workflow state;
- destination verification state;
- open note action.

### UI direction

Use a calm, dense-but-readable clinical workspace: white/light-neutral background, dark text, one restrained blue/cyan primary color, green only for verified success, amber for waiting, and red only for failures/conflicts. Avoid decorative gradients, oversized marketing typography, and excessive cards.

Accessibility requirements:

- all buttons and icon controls have text/accessible labels;
- visible keyboard focus;
- 44px minimum important touch targets;
- WCAG AA contrast;
- status is never communicated by color alone;
- responsive checks at 375, 768, 1024, and 1440px;
- respect `prefers-reduced-motion`;
- confirmation dialogs receive focus and return it correctly.

Supabase Realtime can update processing/export states. If Realtime is unavailable, fall back to modest status polling. Realtime messages must still obey authorization/RLS; see [subscribing to database changes](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes).

---

## 10. Complete appointment-to-PrognoCIS flow

### Flow A — PrognoCIS to Supabase

1. Staff creates/schedules the patient appointment in PrognoCIS.
2. Hermes starts the inbound job on its schedule.
3. The existing extractor reads the configured date window.
4. It validates required patient, appointment, provider, and external identifiers.
5. It creates or updates `care1960_patients` using `(org_id, prognocis_patient_id)`.
6. It creates or updates `care1960_appointments` using `(org_id, prognocis_appointment_id)`.
7. It retains `prognocis_encounter_id` and provider identifiers when available.
8. It writes a safe integration-run result.
9. The frontend receives the row through Realtime or its next query.

This integration targets 1960PA Care because the worker uses the 1960PA `SUPABASE_TENANT_API_KEY` and fixed `SUPABASE_ORG_ID`. The user does not choose an organization in the cron command.

### Flow B — audio to note

1. Doctor signs in with an individual account.
2. RLS limits the schedule to the 1960PA org.
3. Doctor opens an appointment and starts the encounter.
4. `care1960_start_encounter` creates/reuses one active scribe job.
5. Browser records audio with `MediaRecorder` or uploads a supplied file.
6. Browser uploads to the private Storage path.
7. A finalize RPC verifies the path belongs to that org/job and changes status to `QUEUED`.
8. The scribe worker claims the job with a lease.
9. Worker creates a short-lived signed download URL.
10. Worker sends audio to the approved transcription service.
11. Worker validates and stores the transcript.
12. Worker sends transcript plus the versioned template to the approved LLM.
13. Worker requires structured HPI/ROS/PE/Assessment/Plan output and validates it.
14. Worker stores version 1 and changes status to `READY_FOR_REVIEW`.
15. Coding generation stores suggestions separately.
16. Doctor edits; every save appends a note version.
17. Doctor accepts/rejects codes.
18. The atomic attestation RPC freezes the exact note+codes hash and creates an export row.

### Flow C — Supabase to PrognoCIS

1. Hermes runs the reverse worker every five minutes.
2. A new `SupabaseClinicalExportSource` claims up to the configured batch size from `care1960_clinical_exports`.
3. It retrieves the immutable artifact identified by `artifact_hash`.
4. It revalidates the artifact and retained patient/appointment/encounter/provider identity.
5. The existing `PrognocisBrowser` locates the exact destination.
6. It confirms the encounter is editable/open.
7. It fills only empty HPI, ROS, and Physical Examination fields, or treats exact existing content as idempotent.
8. It adds only reviewed/accepted supported diagnoses that are missing.
9. It saves as draft; it never signs/finalizes the EHR.
10. It reopens/readbacks the exact encounter.
11. Only after exact verification, it calls `care1960_acknowledge_export` with the matching hash and opaque encounter ID.
12. Supabase sets export `VERIFIED` and job `EXPORTED`.
13. The frontend shows `Verified in PrognoCIS`.

If non-empty different text is found, the worker records `CONFLICT`, releases the lease, and requires human review. It does not overwrite or endlessly retry.

### Multiple doctors

- Each doctor gets a separate Supabase Auth account and 1960PA membership.
- Each scribe job records `provider_user_id` and the imported PrognoCIS provider mapping.
- Many doctors may record and review simultaneously because jobs are independent rows.
- Multiple scribe-processing workers may run concurrently if queue leasing is correct.
- PrognoCIS browser writeback should remain **one writer per authenticated EHR browser profile** and process a batch sequentially, because simultaneous tabs can corrupt shared session state.
- If different providers require different PrognoCIS logins, create one isolated Chrome profile/CDP endpoint and one queue route per EHR connection; do not share one browser session across those identities.

---

## 11. How the existing two integrations change

### Inbound integration

Keep:

- PrognoCIS login/browser extraction;
- appointment parsing and validation;
- date-window rules;
- idempotency and readback checks.

Replace:

```text
QuickRCM API destination
        with
SupabaseAppointmentDestination
```

The new adapter uses:

```text
SUPABASE_URL
SUPABASE_TENANT_API_KEY
SUPABASE_ORG_ID
```

and calls PostgREST/RPC upserts for patient and appointment.

### Reverse integration

Keep:

- `PrognocisBrowser`;
- strict patient/encounter resolution;
- conflict-safe writes;
- draft-only rule;
- reopen/readback verification;
- lock, audit, and hash semantics.

Replace:

```text
QuickScribeBrowser
        with
SupabaseClinicalExportSource
```

The source adapter should list/claim attested export rows, not scrape our own frontend. This removes dependency on rendered HTML selectors and prevents the new UI from breaking the integration.

The final acknowledgement moves from a local-only ledger to Supabase. Keep the local PHI-free ledger as secondary operational evidence, not the source of truth.

---

## 12. Environment variables: where each one belongs

### Frontend build environment

```dotenv
VITE_SUPABASE_URL=https://supabase-api.quickintell.com
VITE_SUPABASE_ANON_KEY=...
VITE_CLIENT_SLUG=1960pacare
```

Only these belong in browser code. The anon key is designed to identify the project; it is not an authorization substitute. RLS must protect all data.

### Trusted backend/admin environment

```dotenv
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_JWT_SECRET=...
POSTGRES_HOST=...
POSTGRES_PORT=...
POSTGRES_DB=...
POSTGRES_USER=...
POSTGRES_PASSWORD=...
```

Use these only for:

- applying migrations;
- creating/inviting users;
- generating/revoking tenant API keys;
- exceptional platform administration.

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely. Never prefix it with `VITE_`, never put it in React code, never log it, and never give it to Hermes when an org-scoped key is sufficient.

`SUPABASE_JWT_SECRET` is only needed by the existing tenant-key generator or custom verification. Normal Supabase SDK calls already handle user sessions. Never expose the signing secret to the browser.

`POSTGRES_*` works only from the internal network and is for migrations/controlled server operations, not frontend traffic.

### Each trusted 1960PA worker

```dotenv
SUPABASE_URL=...
SUPABASE_TENANT_API_KEY=...
SUPABASE_ORG_ID=<1960PA org UUID>
```

Also give only the worker-specific external secrets it needs:

```text
scribe worker: transcription + LLM credentials
inbound worker: PrognoCIS browser/CDP configuration
outbound worker: PrognoCIS browser/CDP configuration
```

Prefer separate tenant API keys for inbound, scribe processing, and outbound. They can then be individually revoked and audited even though they target the same organization.

---

## 13. Recommended repository layout

In `../1960pacare/Supabase_Applications`:

```text
1960pacare/
  package.json
  vite.config.ts
  src/
    App.tsx
    components/
    pages/
      login/
      dashboard/
      appointments/
      encounters/
      templates/
      users/
      settings/
    providers/
      supabaseClient.ts
      authProvider.ts
      dataProvider.ts
      accessControlProvider.ts
      role.ts
    domain/
      scribeStatus.ts
      clinicalArtifact.ts
  supabase/
    migrations/
      0001_1960pacare_core.sql
      0002_1960pacare_rls_and_grants.sql
      0003_1960pacare_storage.sql
      0004_1960pacare_workflow_rpcs.sql
      0005_1960pacare_service_api_access.sql
      0006_1960pacare_realtime.sql
  worker/
    src/
      queue.ts
      transcription.ts
      note-generation.ts
      coding.ts
      process-scribe-job.ts
  tests/
    rls/
    unit/
    e2e/

supabase/functions/
  care1960-scribe-enqueue/
    index.ts
  care1960-invite-user/        # only if UI-based invites are truly required
    index.ts
```

Function names and their environment-variable names should be prefixed with `CARE1960_` because all functions share the same deployment/environment namespace in this self-hosted stack.

Keep the PrognoCIS automation code in `quickrcm-prognocis-writeback`; do not mix browser selectors and Chrome lifecycle into the static frontend.

---

## 14. Step-by-step implementation order

### Phase 0 — freeze the MVP contract

Before coding, confirm these six facts with 1960PA Care:

1. which providers will use the app and their PrognoCIS provider mappings;
2. whether all users may see all practice appointments or only their own provider schedule;
3. the exact default note template and required sections;
4. which code systems are reviewed/exported in phase 1;
5. audio/transcript/note retention policy;
6. inbound date window and timezone.

Recommended phase-1 decisions: all members see the one org's schedule, accepted ICD-10 only, one default template, and the same timezone as the existing live integration.

### Phase 1 — scaffold the dedicated client

1. Run `npm ci` at the `Supabase_Applications` root for admin scripts.
2. Copy the structural scaffold from `texas-retina` into `1960pacare`.
3. Change package/app names and `CLIENT_SLUG` default to `1960pacare`.
4. Keep the existing auth, role cache, membership rejection, users page, and password-reset flow.
5. Remove Texas Retina resources/pages and add only the scribe routes listed above.
6. Establish the clinical design tokens and accessible layout before building pages.

### Phase 2 — write versioned database migrations

1. Seed/upsert the `clients` and `orgs` rows.
2. Create the `care1960_*` tables and constraints.
3. Add indexes for org/date/status/external identifiers.
4. Revoke unnecessary `anon` grants.
5. Enable RLS on every table.
6. Add membership/role policies for human users.
7. Add tenant-service-key policies for only the tables/actions each worker needs.
8. Create the private audio bucket and object-path RLS.
9. Add atomic workflow RPCs.
10. Add queue leasing/acknowledgement functions.
11. Apply migrations to a staging/self-hosted database using the server-side admin path.
12. Test them as real owner, member, viewer, non-member, different-org user, tenant key, expired/revoked key, and unauthenticated request.

Never test isolation only with `service_role`; it bypasses the protection being tested.

### Phase 3 — onboard users and worker identities

After the org exists, the existing scripts support:

```bash
cd /quickintell/workspaces/anurag_workspace/1960pacare/Supabase_Applications
npm ci

node scripts/invite-user.mjs \
  --email '<doctor email>' \
  --org-slug 1960pacare \
  --role member \
  --redirect-to 'https://<1960PA app domain>/update-password'

node scripts/manage-tenant-api-key.mjs generate \
  --org-slug 1960pacare \
  --label 'prognocis inbound production'
```

Generate distinct keys for scribe processing and outbound writeback. Save each returned token immediately in the correct Coolify/Hermes secret environment; the token is not recoverable later.

Do not paste real credentials into source, Markdown, chat, screenshots, or screen recordings.

### Phase 4 — build appointment and patient reads

1. Implement typed Supabase queries/data-provider mappings.
2. Build Today and Appointments.
3. Build minimal patient context inside the appointment/encounter; add a separate Patients page only if the client needs it.
4. Add loading, empty, error, and retry states.
5. Add Realtime or polling invalidation.
6. Verify a non-member cannot query rows even by manually calling the REST endpoint.

### Phase 5 — build recording and private upload

1. Implement microphone permission handling.
2. Record with `MediaRecorder`; support the known uploaded test audio.
3. Create/reuse a scribe job through an RPC.
4. Upload directly to the permitted private object path using the signed-in user's JWT or a narrowly signed upload URL.
5. Persist only the object path, not a permanent public URL.
6. Finalize/enqueue idempotently.
7. Recover from network interruption without creating duplicate jobs or orphaning silently.

### Phase 6 — extract the agentic processing worker

1. Reuse the useful transcription/note-generation behavior from `rcm_v2`, not its Wasp/Prisma/billing coupling.
2. Make the worker read/write Supabase using the 1960PA tenant key.
3. Claim one queue item with a visibility lease.
4. Refresh the lease during long processing.
5. Generate a short-lived audio download URL.
6. Transcribe, validate, and store transcript.
7. Generate structured sections against the versioned template.
8. Reject malformed/placeholder output instead of marking ready.
9. Store note version 1.
10. Generate coding suggestions.
11. Change status to `READY_FOR_REVIEW`.
12. Add bounded exponential retry and a terminal failed state.
13. Remove current-style logging of full/signed audio URLs and any PHI.

### Phase 7 — build review, code selection, and attestation

1. Render explicit sections and transcript/audio tabs.
2. Save edits as append-only versions.
3. Require accepted/rejected decisions for supported codes.
4. Show the attestation statement and current version.
5. Invoke the atomic attestation RPC.
6. Confirm edits are locked afterward.
7. Confirm exactly one export row with the correct artifact hash is produced.

### Phase 8 — adapt the inbound PrognoCIS sync

1. Add a Supabase destination adapter to the existing six-script flow.
2. Configure its tenant key and org ID.
3. Preserve external IDs and source timestamps.
4. Perform idempotent patient/appointment upserts.
5. Run a read-only/probe test.
6. Run one supervised synthetic appointment import.
7. Run it again and prove no duplicate patient/appointment appears.
8. Only then change/install the production schedule.

### Phase 9 — adapt reverse writeback

1. Add `SupabaseClinicalExportSource` to this repository.
2. Keep `PrognocisBrowser` and its safety tests.
3. Claim exports transactionally with lease expiry.
4. Build the same canonical clinical artifact from the frozen Supabase version.
5. Acknowledge only the identical hash after destination readback.
6. Remove dependence on QuickRCM routes/selectors and manual job mappings.
7. Probe without writes.
8. Perform one supervised synthetic write.
9. Rerun and prove it skips the verified artifact.
10. Enable the five-minute Hermes job.

### Phase 10 — deploy

The existing repository CI already auto-detects a new top-level folder containing `package.json`, builds it, and deploys its `dist/` to the matching S3 prefix. One-time infrastructure remains:

1. add the new subdomain-to-prefix mapping to the CloudFront Function;
2. add the domain alias to the CloudFront distribution;
3. add the DNS CNAME;
4. set `VITE_SUPABASE_URL`, anon key, and client slug in the build environment;
5. deploy the scribe worker separately through Coolify;
6. deploy any prefixed Edge Functions through the existing function workflow;
7. install/enable Hermes jobs only after probes pass.

### Phase 11 — production acceptance

Use a synthetic patient and prove:

1. appointment originates in PrognoCIS;
2. inbound sync creates exactly one patient and appointment in Supabase;
3. the clinician records or uploads audio;
4. transcript and structured note are generated;
5. clinician edits, reviews codes, and attests;
6. outbound worker writes the exact open encounter draft;
7. PrognoCIS readback is exact;
8. UI changes to `Verified in PrognoCIS`;
9. repeating both jobs creates no duplicate and makes no second clinical change;
10. a conflicting non-empty destination field stops safely.

---

## 15. Testing required before production

### Database/RLS tests

- owner/admin/member/viewer permissions;
- no-membership denial;
- cross-org isolation;
- anonymous denial;
- tenant API key allowed actions only;
- revoked/expired/wrong-org tenant key denial;
- forbidden direct status/attestation/export mutations;
- storage object path isolation;
- safe views use `security_invoker` or equivalent protection.

### Unit/contract tests

- appointment/patient normalization and upsert keys;
- scribe state transitions;
- one active job per appointment;
- structured note validation;
- accepted-code selection;
- artifact canonicalization/hash stability;
- stale-version attestation rejection;
- queue claim/lease/retry behavior;
- export acknowledgement requires the same artifact hash.

### Frontend tests

- login/no-membership flow;
- role-based navigation;
- dashboard states;
- microphone denied/granted;
- record/pause/resume/stop/upload;
- double-click/double-submit prevention;
- refresh during processing;
- note edit/version conflict;
- attestation confirmation and lock;
- responsive/keyboard behavior.

Use Playwright for real browser flows. Mock external transcription/LLM/PrognoCIS in regular CI; keep the authenticated live EHR test as a supervised synthetic canary.

### Integration tests

- inbound repeat is idempotent;
- simultaneous doctors get separate scribe jobs;
- worker crash causes lease expiry/recovery;
- wrong/missing encounter ID fails closed;
- different non-empty PrognoCIS text becomes conflict;
- exact existing text becomes an idempotent verified result;
- database acknowledgement is never written before EHR readback.

---

## 16. Security and clinical-data checklist

- Treat patient data, transcript, audio, and note as sensitive clinical data.
- Use TLS for all browser/service connections.
- Keep audio bucket private.
- Use short-lived signed URLs.
- Never expose service-role/JWT/Postgres/tenant keys in the frontend.
- Keep separate, revocable service identities per worker.
- RLS and grants on every exposed table/view/function.
- Immutable attestation and append-only note versions.
- No EHR sign/finalize automation in this phase.
- No blind overwrite of non-empty PrognoCIS fields.
- No PHI in general logs, traces, error trackers, or video proof.
- Encrypt and back up the database/object store according to the organization's policy.
- Define retention and deletion policies for audio, transcript, note, and audit evidence.
- Verify contracts/BAAs and the approved handling of clinical data with Supabase hosting, transcription, LLM, logging, and backup vendors before production. Architecture alone is not a compliance determination.
- Enable MFA for privileged administrators when operationally ready.

---

## 17. What should be excluded from MVP

To avoid recreating the same usability problem, do not include unless 1960PA Care explicitly requests it:

- claims and billing;
- eligibility/prior authorization;
- denial management;
- broad coding/financial dashboards;
- manual organization switching;
- patient intake/insurance demographics beyond what the scribe flow needs;
- general file management;
- arbitrary template marketplace;
- public patient portal;
- automatic final signing in PrognoCIS;
- direct browser access to raw integration configuration or credentials.

The test for every proposed feature is: **Does the doctor or practice administrator need this to move an appointment from scheduled, through a reviewed/attested note, to a verified PrognoCIS draft?** If not, leave it out.

---

## 18. Recommended first implementation PRs

Keep the work reviewable in this order:

1. `feat: scaffold 1960PA scribe client`
2. `feat: add 1960PA clinical schema`
3. `feat: enforce 1960PA tenant policies`
4. `feat: add appointment worklist`
5. `feat: add private audio capture`
6. `feat: add durable scribe processing`
7. `feat: add note review workflow`
8. `feat: add clinical attestation`
9. `feat: sync PrognoCIS appointments`
10. `feat: source writeback from Supabase`
11. `test: cover end-to-end clinical flow`
12. `ops: deploy 1960PA scheduled workers`

Each PR should include its own tests and migration rollback/recovery notes. Never mix credentials or generated audio into a commit.

---

## 19. The key design decisions in one table

| Question | Decision |
|---|---|
| Copy all of `rcm_v2`? | No. Reuse only the scribe domain behavior and proven safety ideas. |
| Separate Postgres tenant schema? | No, not in the currently deployed platform pattern. Use shared `public`, prefixed tables, `org_id`, explicit grants, and RLS. |
| Where are users? | Supabase `auth.users`; organization access is in `public.memberships`. |
| What is the tenant? | The `1960PA Care` row in `public.orgs`, connected to client slug `1960pacare`. |
| Can the frontend call the DB directly? | Yes for permitted CRUD/RPC through the anon key + user JWT + RLS. |
| Does Supabase generate APIs? | Yes for database tables/views/RPCs, plus Auth, Storage, and Realtime APIs. |
| Is that the whole backend? | No. Long-running audio/LLM/browser tasks need durable workers and queues. |
| Where is audio stored? | Private Supabase Storage; the DB stores only metadata/object path. |
| How do crons choose the account/org? | Server-only `SUPABASE_TENANT_API_KEY` plus fixed `SUPABASE_ORG_ID`, not a UI dropdown. |
| How does reverse sync know work is ready? | It polls/claims `care1960_clinical_exports` rows with status `READY`. |
| How does it know work completed? | It writes `VERIFIED` only after PrognoCIS reopen/readback matches the same artifact hash. |
| Can doctors work simultaneously? | Yes in Supabase/scribe workers; keep EHR browser writes serialized per PrognoCIS session. |
| What does the client see? | Today, appointments, encounter recording, note/code review, attestation, and verified destination status—nothing else. |

## Final recommendation

Build the new 1960PA application inside `Supabase_Applications/1960pacare`, starting from the proven `texas-retina` Auth/RBAC/deployment scaffold. Model only patients, appointments, scribe templates/jobs, note versions, code review, immutable attestation, exports, and audit operations. Use Supabase's generated APIs for ordinary reads/writes, narrow RPCs for atomic clinical state transitions, and a durable worker for audio-to-note processing.

Then change the two integrations at their boundaries:

- inbound: PrognoCIS extractor -> **Supabase destination adapter**;
- outbound: **Supabase export source adapter** -> existing safe PrognoCIS browser writer.

That produces the dedicated, understandable product the client asked for without throwing away the already live-tested integration safeguards.
