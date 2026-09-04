# Browser-Only Live Readiness Checklist

The workflow is blocked from live writes until every relevant item below is complete.

## 1. Remote browser login

- Connect to noVNC through the SSH tunnel.
- Log into QuickRCM/QuickScribe in the Chrome profile controlled by CDP `9223`.
- Log into PrognoCIS in another tab of the same Chrome profile.
- Complete MFA without storing credentials in the repository or chat.
- Confirm both sessions survive closing the local noVNC viewer.

## 2. QuickScribe read-only discovery

Using an ATTESTED test note, capture stable rendered selectors for:

- Authenticated application marker and optional login marker.
- Note rows, row status, same-origin detail link, and stable job ID.
- Detail job ID and `ATTESTED` status.
- Patient ID, first name, last name, and DOB.
- Appointment ID, service date, appointment type, and provider when shown.
- Retained PrognoCIS patient/encounter IDs when shown.
- Provider attestation actor and timestamp.
- Complete provider-approved final note.
- Accepted diagnosis rows, ICD-10 code, and optional description.

Confirm that suggested/rejected code rows do not match the accepted-row selector. Do not use application API responses as the clinical source.

## 3. PrognoCIS read-only discovery

Using the corresponding approved test encounter, capture stable selectors for:

- Patient search and active-chart identity.
- Encounter rows, date, type, provider, stable encounter ID, and open control.
- Encounter editor and editable/draft status.
- HPI menu, template lookup if needed, narrative field, and section Save.
- ROS menu, narrative field, and section Save.
- Physical Examination menu, narrative/comment field, and section Save.
- Existing diagnoses and exact diagnosis search/select controls.
- Save Draft and authoritative success proof.

Do not capture Sign, Finalize, Submit Claim, or electronic-signature controls.

## 4. Read-only probe

- Copy the example config to ignored `config/writeback.json`.
- Replace every `TODO_CAPTURE...` value with a verified stable selector.
- Keep `automation.writeEnabled=false`.
- Run `npm run validate:config`.
- Run `npm run probe -- --max-records 1`.
- Confirm Playwright reads one ATTESTED note and opens exactly the intended patient/encounter.
- Confirm no source or destination field changed.

## 5. Supervised draft canary

- Use a designated test patient or specifically approved live canary.
- Manually confirm the source is ATTESTED and the ICD-10 rows are accepted.
- Set `automation.writeEnabled=true` and the exact private `CLINICAL_WRITE_ACK` value.
- Run `npm run run -- --max-records 1` while observing through noVNC.
- Manually reopen PrognoCIS and compare HPI, ROS, Physical Examination, diagnoses, and Draft status.
- Run the unchanged source again and confirm no duplicate text or codes.
- Inspect the private ledger and confirm it contains hashes/opaque IDs only.

## 6. Scheduled deployment

- Confirm the persistent Chrome, Xvfb, localhost CDP, and authenticated sessions work inside the Hermes runtime.
- Keep `.env`, active config, Chrome profile, audit, and ledger owner-only.
- Run the wrapper manually.
- Preview `./scripts/install-hermes-cron.sh --dry-run`.
- Install the separate reverse-flow cron only after approval.
- Monitor `AUTH_REQUIRED`, selector failures, source changes, clinical conflicts, and read-back failures.

## Definition of done

The flow is complete only after Playwright reads one provider-attested QuickScribe note from the UI, writes it to the exact PrognoCIS encounter as a draft, closes/reopens and verifies it, records non-PHI local proof, repeats safely without duplication, and then succeeds from its separate scheduled job. It must never sign or finalize for the clinician.
