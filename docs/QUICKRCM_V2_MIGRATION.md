# QuickRCM Producer Migration to the Version 2 Contract

## Why a producer change is required

The QuickRCM application currently has a version 1 clinical-export prototype in:

```text
rcm_v2/rcm_v2/src/rcm/scribe/clinicalExport.ts
rcm_v2/rcm_v2/src/rcm/scribe/clinicalExportApi.ts
```

That implementation has useful attestation, tenant, hash, and acknowledgement controls, but its payload does not match this task:

| Current v1 behavior | Required v2 behavior |
|---|---|
| One `soapNote` string | Discrete `sections.hpi`, `sections.ros`, and `sections.physicalExamination` |
| Status is checked by the server but absent from payload | Payload status must be exactly `ATTESTED` and is rechecked by consumer |
| ICD-10-CM, CPT, and HCPCS are exported | ICD-10-CM diagnoses only |
| Accepted codes have no per-code reviewer/time proof | Every diagnosis carries `reviewStatus: ACCEPTED`, `acceptedAt`, and `acceptedById` |
| Appointment ID/date/type only | Add provider and retained PrognoCIS patient/encounter identifiers when available |
| Envelope version 1 | Envelope and artifacts version 2 |

The new consumer intentionally rejects v1 instead of silently converting it.

## Required QuickRCM work

1. Persist the human reviewer identity and acceptance timestamp for each accepted ICD-10-CM diagnosis. The current `acceptedCodes` string list proves selection but does not identify who accepted each item or when.
2. Make the provider-approved final note expose HPI, ROS, and Physical Examination as discrete reviewed fields.
3. If the database continues storing one `finalNote`, allow export only when that attested note has all three explicit headings. Use the same deterministic behavior as `src/domain/build-export-artifact.mjs`; do not map Subjective to HPI or Objective to PE by guesswork.
4. Retain PrognoCIS patient and encounter IDs during the existing inbound appointment sync and include them in the outbound record.
5. Update the producer hash to the version 2 canonical fields.
6. Return `{ version: 2, destination: "prognocis", items: [...] }` from the queue.
7. Continue recalculating the current artifact during acknowledgement and reject stale hashes.
8. Update organization-scope, stale-write, and cross-tenant tests.

## Proposed routes

```text
GET  /api/v2/scribe/prognocis-writeback?status=ATTESTED&limit=10
POST /api/v2/scribe/prognocis-writeback/{jobId}/ack
```

The exact routes are configurable, but the response and acknowledgement semantics are not. The acknowledgement body remains deliberately small:

```json
{
  "destination": "prognocis",
  "status": "DRAFT_VERIFIED",
  "artifactHash": "64-character-sha256",
  "ehrEncounterId": "opaque-verified-encounter-id"
}
```

QuickRCM must record this acknowledgement only after confirming that the job is still ATTESTED and the hash still matches the current approved content.

