# Reverse Clinical Write-Back Architecture

## Purpose

The existing integration sends future patients and appointments from PrognoCIS into QuickRCM. This repository implements the opposite direction after a visit: it returns only provider-approved QuickScribe documentation to the original PrognoCIS encounter as an unsigned draft.

## Trust boundaries

There are three independent systems:

1. QuickScribe captures audio and generates proposed documentation and diagnosis codes.
2. QuickRCM owns review state, provider attestation, accepted-code state, the export queue, and acknowledgement.
3. PrognoCIS remains the clinical system of record and owns final clinician signature.

The browser consumer does not trust an item merely because an API returned it. It independently validates the status, attestation proof, section completeness, code review proof, allowed fields, and producer hash before opening a chart.

## Version 2 artifact

The consumer expects this logical shape:

```json
{
  "version": 2,
  "source": "quickrcm-quickscribe",
  "status": "ATTESTED",
  "jobId": "opaque-scribe-job-id",
  "patient": {
    "id": "opaque-quickrcm-patient-id",
    "firstName": "Sample",
    "lastName": "Patient",
    "dob": "1980-01-02",
    "prognocisPatientId": "optional-retained-ehr-id"
  },
  "encounter": {
    "appointmentId": "opaque-quickrcm-appointment-id",
    "startTime": "2026-09-04T15:30:00.000Z",
    "appointmentType": "Follow Up",
    "providerName": "Dr Example",
    "prognocisEncounterId": "optional-retained-ehr-encounter-id"
  },
  "attestation": {
    "at": "2026-09-04T17:00:00.000Z",
    "byId": "opaque-provider-id"
  },
  "sections": {
    "hpi": "Provider-approved HPI narrative",
    "ros": "Provider-approved ROS narrative",
    "physicalExamination": "Provider-approved physical examination narrative"
  },
  "diagnoses": [
    {
      "system": "ICD10CM",
      "code": "R05.9",
      "description": "Cough, unspecified",
      "reviewStatus": "ACCEPTED",
      "acceptedAt": "2026-09-04T17:01:00.000Z",
      "acceptedById": "opaque-reviewer-id"
    }
  ],
  "artifactHash": "canonical-SHA-256"
}
```

Raw audio and raw transcript fields are not part of the contract. Unknown fields are rejected so they cannot leak through an accidental producer change.

The hash covers all fields except `artifactHash`, including review and attestation state. QuickRCM and this consumer must share the same canonical hash algorithm and a fixed test vector before deployment.

## Exact destination resolution

Patient matching always requires exactly one visible row containing the same normalized first name, last name, and DOB. When the inbound appointment sync begins retaining a PrognoCIS patient ID, that ID is an additional requirement; it never replaces demographic verification.

Encounter matching always requires:

- The service date derived in the configured clinic timezone.
- Exact normalized appointment type equality.
- Exact provider equality when `providerName` is supplied.
- Exact retained encounter ID when `prognocisEncounterId` is supplied.
- Exactly one final matching row.

Zero matches and multiple matches are both terminal record failures. The integration never chooses the first row and never creates a patient or encounter.

## Draft write algorithm

For each validated artifact, the destination does the following sequentially:

1. Open the exact chart and exact encounter.
2. In probe mode, stop here and return `PROBED` without opening clinical fields.
3. In write mode, read HPI, ROS, Physical Examination, and existing diagnosis rows.
4. Require the encounter status to match a narrowly configured editable state; Signed, Finalized, or otherwise unknown states stop the record.
5. If all approved text and codes already exist and the status is Draft, return an idempotent verified result.
6. If any non-empty section differs from the approved text, stop before writing anything.
7. Fill only empty sections, checking the field value before using each section's Save control.
8. Search each missing accepted ICD-10-CM code and require exactly one code result before selecting it.
9. Use only the configured Save Draft control.
10. Require an authoritative save response or configured success marker and visible Draft status.
11. Close the editor, return to the application entry point, select the exact patient again, and reopen the exact encounter.
12. Re-read all three sections, every accepted ICD-10 code, the encounter ID, and Draft status.
13. Return `DRAFT_VERIFIED` only when the complete comparison succeeds.
14. Send QuickRCM an acknowledgement containing only destination, status, artifact hash, and opaque EHR encounter ID.

If the process stops after a partial save, the next run performs the same full pre-write read. Exact existing fields are skipped, empty fields are resumed, and different text causes a stop. No blind save retry is performed.

## HPI template handling

Some PrognoCIS encounters keep the HPI narrative disabled until a visit template is selected with the binoculars control. The optional template automation uses an exact configuration map from QuickRCM appointment type to PrognoCIS template name. It requires exactly one matching template row. There is no default template and no fuzzy choice.

## Why only narrative ROS and physical examination

The initial implementation writes provider-approved narrative text into the three destination clinical sections. It does not infer positive/negative symptom checkboxes, organ-system selections, normal/abnormal states, or structured exam findings from prose. Those transformations would require a separately reviewed structured source schema and explicit mapping rules.

## Browser topology

In the remote setup, Chrome is headed and runs on Xvfb display `:99`. An operator reaches it through noVNC for credentials and MFA. Playwright reaches the same Chrome over the localhost CDP port. Closing the Playwright connection does not terminate the operator's persistent Chrome.

CDP can fully control an authenticated browser, so the configuration accepts it only on localhost. noVNC should be exposed only through an SSH tunnel or another approved private network path.

## Audit behavior

Runtime audit lines contain only:

- Random run ID
- Hashed job key
- Artifact SHA-256
- Counts, mode, status, duration, and controlled error code

Names, DOB, section text, code descriptions, transcripts, and credentials are not logged.
