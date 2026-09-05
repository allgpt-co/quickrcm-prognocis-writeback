# Live Write-Back Test Status

Last updated: September 5, 2026

## What Is Working Correctly

- The authorized synthetic patient and an open encounter were created in PrognoCIS.
- A corresponding QuickRCM appointment was created and processed through QuickScribe.
- The QuickScribe note reached `Attested` status with an accepted ICD-10-CM diagnosis.
- The browser-only script correctly:
  - accepts only attested notes;
  - extracts data from the rendered QuickRCM interface rather than API responses;
  - extracts explicit HPI, ROS, and Physical Examination sections;
  - extracts accepted ICD-10-CM rows only;
  - matches exactly one patient by first name, last name, and date of birth;
  - matches exactly one encounter by service date and appointment type; and
  - refuses to overwrite different non-empty clinical text.
- The read-only probe successfully located the exact PrognoCIS encounter.
- HPI, ROS, and Physical Examination were saved and read back as exactly matching the attested note.
- The accepted ICD-10-CM code `J06.9` was added and confirmed by read-back.
- The exact encounter was saved and reopened while remaining in `Open` status.
- QuickScribe was revalidated as attested and unchanged immediately before the PHI-free verification proof was recorded.
- The first completed live run returned one written and verified draft with zero failures.
- A second run skipped the same artifact from the verification ledger, proving idempotency and preventing a duplicate write.
- Nothing was signed, finalized, closed, electronically attested, or sent to claims.
- The PHI-free verification ledger contains one completed-draft proof.
- All 37 automated tests pass.

## Live Result

The supervised reverse write-back canary is complete. The attested QuickScribe draft was written to the retained synthetic PrognoCIS encounter, reopened, read back, and verified without advancing the encounter beyond its editable open state.

## Issues Found and Repaired During the Canary

- PrognoCIS permits only one active application window. A stale login/close window produced the platform's duplicate-window alert; the automation now reuses the authenticated application page instead of opening another application instance.
- Re-clicking the legacy Assessment menu could replace its frame while the diagnosis popup was opening. The script now waits for and reuses the already-rendered diagnosis section.
- The diagnosis picker initially searched only the provider's Preferred list. The live configuration now opens the General list and matches both Preferred and General rendered result rows.

## Completion Status

No supervised reverse write-back canary steps remain. Final repository checks pass.

Hermes deployment and scheduling are documented in [`HERMES_CRON_GUIDE.md`](HERMES_CRON_GUIDE.md).

## Known Integration Issue

The automatic PrognoCIS-to-QuickRCM appointment synchronization placed the test appointment in a tenant that was not visible to the active QuickRCM user. A visible test appointment therefore had to be created manually. This tenant-routing problem remains separate from the reverse clinical write-back test.
