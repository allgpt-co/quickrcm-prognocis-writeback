# Production second cron: Care1960 to PrognoCIS

Migration `0010` is already applied in production. Do not run it again. The
read-only clinical RPC is separate from the first cron's appointment sync API:

```text
POST https://supabase-api.quickintell.com/rest/v1/rpc/care1960_get_attested_clinical_records
```

The RPC returns a root array of provider-attested HPI, ROS, Physical Examination,
original PrognoCIS identities, and attestation metadata. It creates no queue and
updates no appointments. `[]` is valid when no record is eligible.

## Private setup

The repository's `.env`, active `config/writeback.json`, and `.runtime/` files
are Git-ignored. Use owner-only permissions (`.env`/request files: `600`, runtime
directory: `700`). Never put credentials or real patient IDs in chat, source
control, screenshots, request credentials, or logs.

Fill `.env` privately with the same production instance's gateway anon key and
registered tenant JWT:

```dotenv
SUPABASE_ANON_KEY=<production gateway anon key>
SUPABASE_TENANT_API_KEY=<registered production Care1960 tenant JWT>
prognosis_username=
prognosis_password=
CLINICAL_WRITE_ACK=
```

PrognoCIS credentials are required only with `loginPerRun=true`; otherwise use
the authenticated localhost Chrome/CDP profile. Do not use a service-role key,
doctor's login JWT, local key, or `VITE_*` variable. This process does not need
Supabase application/admin or Postgres credentials.

Keep the captured selectors and full active configuration. Its `care1960` block
must use `input: "http"`, the production URL above,
`requestFile: ".runtime/care1960-request.json"`, `timeoutMs: 30000`,
`recordsPath: ""`, and `fields: {}`. Set `orgId` privately to the actual
production org UUID. The tenant JWT authorizes the org; `orgId` is an additional
response check, not a request selector. Preserve `draftOnly=true` and
`writeEnabled=false` initially.

Replace the private request's placeholder with one actual scribe-job UUID:

```json
{
  "p_scribe_job_id": "<actual Care1960 scribe-job UUID>",
  "p_limit": 1
}
```

Optionally add both `p_prognocis_patient_id` and `p_prognocis_encounter_id` using
original EHR IDs, not Supabase UUIDs. Patient and encounter filters are paired.
Unconfigured placeholders or invalid filters are rejected before network access.

## Validation and supervised canary

```bash
npm run validate:config -- --config config/writeback.json
npm run validate:response -- --config config/writeback.json --max-records 1
```

The second command performs one read-only POST without opening a browser.
Success for the exact eligible canary prints:

```json
{"mode":"validate-response","validated":1,"ehrWrites":0}
```

`validated:0` means no matching eligible note. Do not proceed to a write unless
the expected canary validates. Confirm the intended PrognoCIS account is logged
into Chrome/CDP, then run:

```bash
npm run probe -- --config config/writeback.json --max-records 1
```

Review the PHI-free audit and matching destination encounter. Only for an
explicitly approved supervised draft write, set `automation.writeEnabled=true`
and `CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES`, then run:

```bash
npm run run -- --config config/writeback.json --max-records 1
```

HPI is the main target. It must save to the HPI narrative field and verify after
a fresh reopen in draft status before optional sections are visited. HPI errors
fail the record; delivery cannot be guaranteed if credentials, identity,
conflicts, field editability, save, or verification fail.

ROS and Physical Examination are best effort and never overwrite different text.
Failures are audited separately. `HPI_DRAFT_VERIFIED_PARTIAL` means HPI verified
but some optional delivery is incomplete. Such results are not entered into the
all-three completion ledger; later runs retry secondary sections without rewriting
identical HPI. Review `partial` and `optionalFailures` even on exit code zero.
Assessment/Plan, ICD codes, structured ROS checkboxes, signing, and finalization
are outside this worker's scope.

## Scheduling and errors

Only schedule Hermes after reviewing the supervised canary and replay behavior.
Cron must have private credentials, active config, persistent runtime ledger,
and the authenticated CDP endpoint. Keep `draftOnly=true` permanently.

The writer does not paginate automatically or advance a cursor. Repeated
first-page requests repeat records. Start with the exact-job canary; a future
batch wrapper must persist `p_after_attested_at` plus `p_after_scribe_job_id`
only after every destination result, including partials, is reconciled.
`X-Care1960-Has-More: true` indicates another page. `p_limit` is 1–100 and
`p_attested_since` is supported. See [scheduling](HERMES_CRON_GUIDE.md).

- `401/403`: wrong, expired, revoked, or cross-instance gateway/tenant credentials.
- `404`: wrong project/RPC endpoint or schema cache; do not automatically rerun migrations.
- `200` with `[]`: no matching eligible three-section attested record.
- `400`: invalid filters, missing pairs, UUID, or timestamp.
- Repeated records: expected without cursor-aware batch scheduling.

## Docker transition (planned, NOT active)

The Hermes job above still executes the host-based wrapper
(`exec node src/cli.mjs run --config config/writeback.json`). A containerized
equivalent exists as a template only — `scripts/writeback-wrapper.docker.template.sh`
→ `docker compose run --rm -T writeback` — and is **not** scheduled. Do not
switch the scheduler until the manual validation checklist in
[DOCKER_PRODUCTION_TRANSITION.md](DOCKER_PRODUCTION_TRANSITION.md) has passed.
