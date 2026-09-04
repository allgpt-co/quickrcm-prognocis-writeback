# QuickScribe to PrognoCIS Browser Write-Back

This repository implements the reverse clinical-documentation workflow entirely through the rendered web interfaces. It does not read a QuickRCM API response and does not require a QuickRCM API key.

```text
Playwright reads the QuickRCM/QuickScribe UI
        -> selects only an ATTESTED note
        -> extracts patient + encounter identity
        -> extracts explicit HPI + ROS + Physical Examination
        -> extracts accepted ICD-10-CM rows only
        -> rechecks that the source is unchanged
        -> opens the exact patient and encounter in PrognoCIS
        -> saves the clinical content as Draft
        -> closes and reopens the encounter
        -> verifies every field and code
        -> rechecks QuickScribe and records local verified proof
```

## Safety boundary

The workflow requires all of the following:

- The note status displayed in QuickScribe is exactly `ATTESTED`.
- The attesting provider and timestamp are visible.
- The provider-approved note has explicit HPI, ROS, and Physical Examination headings.
- ICD-10-CM codes come only from the UI selector for accepted diagnosis rows.
- The same QuickScribe screen is re-read immediately before the EHR operation and again after EHR verification.
- Exactly one PrognoCIS patient matches first name, last name, and DOB.
- Exactly one encounter matches service date and appointment type, plus provider and retained EHR identifiers when available.
- Existing non-empty clinical text must either match exactly or the record stops.
- The encounter must have an explicitly configured editable status.
- A fresh reopen must prove all three sections, every ICD-10 code, the same encounter ID, and Draft status.

The code has no Sign, Finalize, or Submit Claim path. Raw audio, raw transcript, CPT, HCPCS, suggested codes, and generic Subjective/Objective-to-EHR guesses are excluded.

## Current state

Implemented:

- Playwright QuickScribe list/detail extractor.
- ATTESTED-only rendered-status gate.
- Strict HPI/ROS/Physical Examination heading parser.
- Accepted ICD-10-row extraction.
- Source hash and before/after source revalidation.
- Exact PrognoCIS patient and encounter matching.
- Conflict-safe section and diagnosis writes.
- Draft-only save and close/reopen verification.
- Private PHI-free audit and verified-artifact ledger.
- Probe/run commands and a separate disabled-by-default Hermes cron installer.

Still required before a live write:

- Log into QuickRCM and PrognoCIS in the remote Chrome through noVNC.
- Inspect the real rendered pages and capture stable selectors.
- Confirm how an ATTESTED note displays its three clinical sections and accepted diagnosis codes.
- Run a read-only one-record probe.
- Run one supervised approved test-patient draft canary.

The example configuration deliberately contains `TODO_CAPTURE...` selectors and cannot be activated as-is.

## Development setup

```bash
npm install
cp .env.example .env
cp config/writeback.example.json config/writeback.json
npm test
```

The `.env`, active configuration, browser profile, audit log, and verified ledger are ignored by Git.

## Commands

After browser selector discovery:

```bash
# Structure only: no website interaction.
npm run validate:config

# Reads QuickScribe and opens the exact PrognoCIS encounter; cannot fill/save.
npm run probe -- --max-records 1

# Only after the supervised canary has been approved.
npm run run -- --max-records 1
```

Draft writes require `automation.writeEnabled=true` and this exact private environment acknowledgement:

```text
CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES
```

## noVNC and the shared browser

Chrome runs headed on remote Xvfb display `:99`. A human reaches that screen through noVNC for login/MFA, while Playwright controls the same Chrome through localhost CDP port `9223`.

```text
Human -> SSH tunnel -> noVNC -> websockify -> x11vnc -> Xvfb :99 -> Chrome
Playwright ----------------------------------- CDP 127.0.0.1:9223 -> Chrome
```

noVNC is the human viewing/control route, not the automation engine. Both VNC `5900` and noVNC `6080` remain localhost-only. CDP must also remain localhost-only.

## Repository map

| Path | Responsibility |
|---|---|
| `src/integrations/quickscribe-browser.mjs` | Reads ATTESTED note data from the rendered QuickScribe UI |
| `src/domain/build-export-artifact.mjs` | Extracts explicit HPI, ROS, and Physical Examination headings |
| `src/domain/clinical-artifact.mjs` | Validates and hashes the in-memory browser artifact |
| `src/integrations/prognocis-browser.mjs` | Exact EHR navigation, draft write, and read-back |
| `src/workflow/writeback.mjs` | Double source check, destination call, and verified-ledger ordering |
| `src/runtime/ledger.mjs` | Stores only non-PHI verified hash proof locally |
| `config/writeback.example.json` | Browser-source and browser-destination selector template |
| `docs/ARCHITECTURE.md` | Detailed browser-to-browser design |
| `docs/LIVE_READINESS_CHECKLIST.md` | Selector discovery, probe, canary, and deployment gates |

## Cron isolation

The reverse clinical job remains separate from the existing appointment-import job:

| Job | Direction |
|---|---|
| `prognocis-quickrcm-daily-dev` | PrognoCIS to QuickRCM appointments |
| `quickrcm-prognocis-clinical-drafts` | QuickScribe UI to PrognoCIS drafts |

Preview only:

```bash
./scripts/install-hermes-cron.sh --dry-run
```

Do not install the cron until the live-readiness checklist is complete.
