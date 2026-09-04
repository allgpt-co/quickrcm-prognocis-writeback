# QuickScribe Dev UI Discovery

Read-only selector discovery was performed against the authenticated `dev.quickintell.com` browser session on September 4, 2026. No note, diagnosis, appointment, patient, or coding state was changed. In particular, **Generate Codes**, diagnosis review controls, and all draft/write controls were not used.

This document intentionally contains no patient names, dates of birth, MRNs, clinical text, credentials, or encounter UUIDs.

## Confirmed rendered routes and elements

| Purpose | Rendered route or locator |
|---|---|
| Authenticated application root | `#main-content` |
| Scribe encounter queue | `/scribe/encounters` |
| Queue table | `table[aria-label="Scribe encounters"]` |
| Queue rows | `table[aria-label="Scribe encounters"] tbody tr` |
| Status within a queue row | `td:nth-child(6)` |
| Encounter detail route | `/scribe/encounters/<UUID>` |
| Encounter detail root | `#main-content` |
| Patient display name | `#main-content h1` |
| Provider-approved rendered note | active tab panel named `Output Note` |
| Coding detail route | `/medical-coding/outpatient-billing/<UUID>` |
| Patient directory | `/ehr/patients` |
| Appointment directory | `/ehr/appointments` |

Queue rows do not currently contain an anchor, `data-*` job identifier, or other stable rendered identifier. The row itself is keyboard-focusable and clickable. Clicking it changes the rendered URL to the encounter-detail UUID. The source adapter therefore supports row-click navigation plus a configured URL capture pattern; it still verifies same-origin navigation and stable identity on the detail page.

The UI renders status as `Attested`, not the earlier all-caps fixture value. The adapter canonicalizes rendered status for an exact `ATTESTED` comparison; it does not relax the allowed source status.

## Eligibility result for the current authenticated data

Five rendered Scribe encounters were in Attested status across the displayed queue pages. None met the complete export contract:

- Every corresponding generated-coding view showed zero explicitly accepted diagnoses.
- Some notes were missing one or more required HPI, ROS, or Physical Examination sections.
- Other notes contained only an undocumented placeholder in the required sections.

Consequently, there is currently **no eligible source record for a PrognoCIS draft canary**. The application now rejects placeholder-only clinical sections, including lists in which every labeled item is `Not documented`.

## Identity and attestation gaps in the current detail UI

The encounter-detail UI visibly provides a display name, MRN text, service date, template, status, creation time, and attestation time. It does not visibly provide all fields required for safe destination resolution:

- stable QuickRCM patient ID;
- separate authoritative first and last names;
- patient date of birth;
- stable appointment ID;
- appointment type;
- encounter provider;
- attesting provider identifier or name;
- retained PrognoCIS patient or encounter ID.

The patient directory visibly provides full name and DOB. It can be used only when an exact display-name query returns exactly one patient; duplicate names are present, so a first-row or fuzzy match is prohibited. A sampled patient detail showed no synced EHR encounters. The appointment directory visibly provides patient, DOB, appointment date, and service type, but not provider, and the sampled source service date did not establish an exact unique appointment association.

No clinical identity was inferred by splitting a display name, guessing an appointment, or reading application API responses.

## Remaining source gate

Before a read-only end-to-end probe can succeed, a designated provider-approved test encounter must visibly expose or safely join all required identity and attestation fields and must have:

1. status Attested;
2. substantive HPI, ROS, and Physical Examination content;
3. one or more diagnoses explicitly marked Accepted;
4. an exact unique patient and appointment association;
5. provider attestation actor and timestamp.

If those fields cannot be exposed in the rendered UI, the browser-only workflow remains blocked by design. The automation must not compensate with clinical guesses or source API payloads.
