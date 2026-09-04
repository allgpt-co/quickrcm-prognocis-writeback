# Live Readiness Checklist

The code is deliberately blocked from live use until this checklist is complete.

## 1. QuickRCM producer

- Implement the version 2 queue shape documented in `ARCHITECTURE.md`.
- Return only jobs whose current status is exactly `ATTESTED`.
- Include only human-accepted ICD-10-CM diagnoses with acceptance actor and timestamp.
- Exclude raw audio, raw transcript, CPT, and HCPCS fields.
- Implement the same canonical SHA-256 algorithm and shared test vector.
- Deploy the queue and exact-hash acknowledgement endpoints.
- Issue a dedicated organization-scoped service key with only the required read/ack scopes.
- Confirm stale-hash acknowledgements and cross-organization access are rejected.

## 2. Preserve original EHR identity

- Update the existing PrognoCIS-to-QuickRCM appointment sync to retain PrognoCIS patient ID.
- Retain the stable PrognoCIS encounter/appointment ID when available.
- Include both IDs in the reverse artifact without weakening demographic/date/type checks.

## 3. Read-only selector discovery

Using an approved test patient and the persistent remote Chrome, capture stable selectors for:

- Patient search control, first/last-name fields, results, and active-chart identity.
- Encounter menu, rows, exact date/type/provider cells, stable encounter ID, and open control.
- Encounter editor ready marker.
- HPI menu, narrative field, template lookup/results if needed, and Save.
- ROS menu, narrative field, and Save.
- Physical Examination menu, comment/narrative field, and Save.
- Diagnosis menu, existing rows, add/search/results/select controls.
- Save Draft, authoritative save response/success marker, and Draft status.

Do not capture or configure Sign, Finalize, Submit Claim, or electronic-signature controls.

## 4. Probe

- Copy `config/writeback.example.json` to the ignored `config/writeback.json`.
- Replace every `TODO_CAPTURE...` value.
- Keep `automation.writeEnabled` set to `false`.
- Run `npm run validate:config`.
- Run `npm run probe -- --max-records 1`.
- Manually confirm that the exact test patient and exact encounter opened.
- Confirm no HPI, ROS, PE, code, encounter status, or other chart value changed.

## 5. Supervised draft canary

- Use a designated non-production or approved test-patient encounter.
- Confirm the artifact is provider-attested and all ICD-10 codes are accepted.
- Set `automation.writeEnabled` to `true`.
- Set the exact `CLINICAL_WRITE_ACK` value in the private environment.
- Run `npm run run -- --max-records 1` while observing the remote Chrome.
- Manually reopen the encounter and compare HPI, ROS, PE, accepted ICD-10 codes, and Draft status.
- Run the same artifact again and confirm nothing is duplicated.
- Confirm QuickRCM acknowledgement refers to the exact artifact hash and EHR encounter ID.

## 6. Deployment

- Install production dependencies in the Hermes-visible deployment path.
- Keep `.env`, active config, browser profile, and runtime directory owner-only.
- Confirm Chrome/Xvfb/CDP and authenticated PrognoCIS session operation inside the runtime environment.
- Run the wrapper manually inside the container.
- Preview `./scripts/install-hermes-cron.sh --dry-run`.
- Install the separate hourly job only after approval.
- Keep the existing daily appointment sync unchanged.
- Configure monitoring for nonzero exit, `AUTH_REQUIRED`, selector failure, conflicts, and read-back failure.

## Definition of done

The work is complete only when one provider-attested artifact is written to the exact encounter as a draft, independently reopened and verified, acknowledged in QuickRCM by exact hash, safely repeated without duplicates, and then processed successfully by the separate scheduled job. The automation must never sign or finalize for the clinician.

