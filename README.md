# QuickRCM/QuickScribe to PrognoCIS Write-Back

This repository contains the reverse clinical-documentation automation:

```text
QuickScribe provider-attested result
        -> QuickRCM export queue
        -> strict artifact validation
        -> exact PrognoCIS patient and encounter
        -> HPI + ROS + Physical Examination + accepted ICD-10-CM
        -> save as Draft
        -> close and reopen the encounter
        -> read-back verification
        -> acknowledge the exact artifact in QuickRCM
```

It is intentionally separate from the existing PrognoCIS-to-QuickRCM appointment sync and from the pending-attestation document automation.

## Safety boundary

The consumer accepts a record only when all of these are true:

- Its source status is exactly `ATTESTED`.
- Provider attestation time and actor are present.
- HPI, ROS, and Physical Examination are all non-empty.
- Every diagnosis is `ICD10CM` and has human review status `ACCEPTED`.
- Every accepted diagnosis has reviewer identity and acceptance time.
- The SHA-256 artifact hash matches the complete approved payload.
- Exactly one patient matches first name, last name, and DOB.
- Exactly one encounter matches service date and appointment type, plus provider and retained PrognoCIS encounter ID when supplied.

The automation does not accept raw audio, raw transcripts, CPT, HCPCS, unreviewed suggestions, or unknown payload fields. It has no Sign, Finalize, or Submit Claim operation. A configuration containing such a selector is rejected.

## Current implementation state

The repository now includes:

- A versioned, strict clinical artifact contract.
- Independent revalidation of `ATTESTED` and human-accepted ICD-10 state.
- A QuickRCM queue and acknowledgement client.
- A Playwright PrognoCIS adapter for exact patient/encounter matching.
- Discrete HPI, ROS, and Physical Examination writers.
- Conflict detection that refuses to overwrite different existing text.
- Missing-code-only ICD-10 insertion.
- Draft save proof and close/reopen read-back verification.
- Idempotent duplicate handling and acknowledgement-after-verification ordering.
- A private run lock and PHI-free audit log.
- Probe and live commands plus a disabled-by-default Hermes cron installer.
- Unit tests for the approval gates, matching, API boundary, and workflow ordering.

It is **not live-ready yet**. The QuickRCM v2 queue endpoints in this repository's contract must be implemented/deployed, and the exact PrognoCIS selectors must be captured on an approved test encounter. The example configuration deliberately contains `TODO_CAPTURE...` values, which configuration validation rejects.

## Set up for development

Requirements: Node.js 22 or newer and a compatible Chrome/Chromium installation.

```bash
npm install
cp .env.example .env
cp config/writeback.example.json config/writeback.json
npm test
```

Do not put credentials or patient data in Git. `.env`, the active config, browser profiles, locks, and audit output are ignored.

## Commands

After replacing every selector placeholder and setting `QUICKRCM_API_KEY`:

```bash
# Validates structure only; it does not open a browser or call an API.
npm run validate:config

# Opens only the exact patient and encounter. It cannot fill or save.
npm run probe -- --max-records 1

# Available only after the supervised canary and explicit write gates.
npm run run -- --max-records 1
```

Live draft mode requires both:

1. `automation.writeEnabled` set to `true` in `config/writeback.json`.
2. This exact private environment value:

```text
CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES
```

Neither condition enables signing. Signing is not implemented.

## Remote browser and noVNC

The recommended production configuration attaches Playwright to the existing headed Chrome through local CDP at `127.0.0.1:9223`. Chrome runs on remote Xvfb display `:99`; noVNC lets a human see that same screen for login or MFA.

```text
Human -> noVNC -> websockify -> x11vnc -> Xvfb :99 -> Chrome
Playwright ---------------------- CDP 127.0.0.1:9223 -> Chrome
```

noVNC is not the automation engine. Playwright performs the workflow; noVNC is only the human view/control path. The CDP endpoint must remain localhost-only, and the validator refuses a public CDP host.

## Repository map

| Path | Responsibility |
|---|---|
| `src/domain/clinical-artifact.mjs` | ATTESTED-only contract, accepted ICD-10 validation, canonical hash |
| `src/domain/build-export-artifact.mjs` | Deterministic v2 producer builder; refuses ambiguous SOAP-to-section guessing |
| `src/domain/matching.mjs` | Exact patient and encounter identity rules |
| `src/integrations/quickrcm-client.mjs` | Queue read and post-verification acknowledgement |
| `src/integrations/prognocis-browser.mjs` | Playwright chart, encounter, section, code, draft, and read-back flow |
| `src/workflow/writeback.mjs` | Sequential orchestration and acknowledgement ordering |
| `src/runtime/` | Configuration gates, lock, private files, PHI-free audit |
| `config/writeback.example.json` | Selector/config template that cannot be activated as-is |
| `scripts/install-hermes-cron.sh` | Separate hourly no-agent job installer; never run automatically |
| `docs/ARCHITECTURE.md` | Detailed end-to-end design and idempotency behavior |
| `docs/LIVE_READINESS_CHECKLIST.md` | Required discovery, canary, and activation sequence |
| `docs/QUICKRCM_V2_MIGRATION.md` | Exact changes needed from the existing QuickRCM v1 export prototype |

## Cron isolation

The reverse job is separate from the appointment-import job:

| Job | Direction | Schedule intent |
|---|---|---|
| `prognocis-quickrcm-daily-dev` | PrognoCIS to QuickRCM appointments | Existing daily job |
| `quickrcm-prognocis-clinical-drafts` | QuickRCM to PrognoCIS drafts | Proposed hourly poll at minute 15 |

Previewing the proposed cron does not change Hermes:

```bash
./scripts/install-hermes-cron.sh --dry-run
```

Do not install it until every item in [the live-readiness checklist](docs/LIVE_READINESS_CHECKLIST.md) is complete.
