# Browser-to-Browser Clinical Write-Back Architecture

## Why there is no QuickRCM API dependency

Both applications already expose the required information and actions in their authenticated web interfaces. Playwright attaches to the persistent remote Chrome and works through those rendered pages:

```text
QuickRCM/QuickScribe tab --read--> in-memory validated artifact
                                             |
                                             v
PrognoCIS tab <-------------write Draft through exact UI controls
```

No QuickRCM API endpoint, service key, producer deployment, or API acknowledgement is part of this repository.

## Shared browser topology

The operator and Playwright use different routes to the same headed Chrome process:

```text
Operator laptop browser
  -> SSH tunnel localhost:6080
  -> noVNC/websockify
  -> x11vnc
  -> Xvfb display :99
  -> Chrome windows

Automation process
  -> localhost CDP :9223
  -> the same Chrome context and authenticated tabs
```

The operator uses noVNC to log into QuickRCM and PrognoCIS and complete MFA. The automation later reuses those authenticated browser sessions. noVNC does not parse or move clinical data.

## Source extraction

The QuickScribe adapter first opens the configured attested-notes screen. It reads each rendered row and accepts only rows whose status element resolves to `ATTESTED`. It requires a stable job ID and same-origin detail link.

On the detail screen it independently confirms:

- The stable job ID is unchanged.
- Detail status is still `ATTESTED`.
- Patient first name, last name, DOB, and stable QuickRCM patient ID are present.
- Appointment ID, service date, and appointment type are present.
- Provider attestation actor and timestamp are present.
- The provider-approved final note is non-empty.
- At least one explicitly accepted ICD-10-CM row exists.

The adapter does not inspect network responses for clinical content. It reads locators in the rendered DOM.

## Clinical section mapping

The source note must explicitly contain these headings or their exact long forms:

- `HPI` or `History of Present Illness`
- `ROS` or `Review of Systems`
- `PE`, `Physical Exam`, or `Physical Examination`

All three sections must be non-empty and occur once. A generic SOAP note containing only Subjective and Objective is rejected because automatically guessing which sentences belong in HPI, ROS, or Physical Examination would be unsafe.

The first implementation maps narrative text only. It does not infer symptom checkboxes, negative findings, organ-system selections, or normal/abnormal exam states from prose.

## Diagnosis mapping

The QuickScribe configuration has a selector specifically for accepted diagnosis rows. Only visible rows under that selector are read. Each code must match the ICD-10-CM shape and the in-memory artifact labels it `ACCEPTED`.

CPT, HCPCS, suggested, rejected, and unreviewed rows are not read. If the live interface does not distinguish accepted diagnoses with a stable DOM state, the workflow remains blocked until that distinction is available.

## In-memory artifact and hash

The extracted record exists only in process memory. It contains:

- Source job ID and `ATTESTED` status
- Patient and encounter identity
- Provider attestation proof
- HPI, ROS, and Physical Examination
- Accepted ICD-10-CM diagnoses
- A canonical SHA-256 hash

No clinical artifact JSON file is written to disk. Audit logs contain only a one-way job hash, artifact hash, stage, controlled status/error code, count, and duration.

## Double source validation

Browser pages can change while an automation run is active. The workflow therefore reads the same QuickScribe note three times:

1. Initial extraction.
2. Immediately before opening/writing the PrognoCIS destination.
3. After PrognoCIS close/reopen verification and before recording local completion.

All three reads must remain `ATTESTED` and have the same artifact hash. A change stops the record. If a provider edits the source during the EHR write, the EHR result is not marked complete and requires operator reconciliation.

## Exact destination resolution

Patient matching requires exactly one row with the same normalized first name, last name, and DOB. A retained PrognoCIS patient ID, when visible in QuickRCM, becomes an additional required match.

Encounter matching requires service date and exact appointment type. Provider name and retained encounter ID become additional requirements when visible. Zero or multiple matches stop the record.

## Draft write and verification

Before filling anything, Playwright checks that the encounter has an approved editable status and reads HPI, ROS, Physical Examination, and existing diagnoses.

- Exact existing text is treated as idempotent.
- Empty text may be populated.
- Different non-empty text causes a conflict stop.
- Only missing accepted ICD-10-CM codes are added.
- Every code search must yield exactly one matching code result.
- Only configured section Save and Save Draft controls are used.

After saving, Playwright closes the editor, returns to the PrognoCIS entry screen, selects the patient again, and reopens the encounter. It verifies every section, every expected ICD-10 code, stable encounter ID, and Draft status.

Only then does the private local ledger record the artifact hash, hashed job ID, opaque EHR encounter ID, timestamp, and `DRAFT_VERIFIED` status. The ledger contains no name, DOB, or clinical content.

## Retry behavior

The local ledger skips a previously verified hash. If the ledger is lost, destination read-back still recognizes an exact existing draft as an idempotent success. A partial previous run is resumed only when existing content is either exact or empty. Different content is never overwritten.
