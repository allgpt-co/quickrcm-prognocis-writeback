# PrognoCIS: Wellness Exam complaint before HPI

## Write sequence

The live config uses `prognocis.draftSaveStrategy: "sections-only"`. Only HPI,
ROS, and Physical Examination are visited for narrative saves. There is no
Assessment navigation or separate encounter-save button. Completion still
requires reopening the exact encounter, verifying all narratives, and proving
the configured Open/unsigned status. For supervised tests `--no-acknowledge`
withholds the Care1960 update and API cursor advancement.

1. Search by first and last name and validate the matching patient, including DOB.
2. Open the matching existing encounter and verify it is editable.
3. Explicitly open the HPI menu before opening the complaint lookup.
4. Search for `Wellness exam`, using `prognocis.hpiComplaintName` for every
   appointment type.
5. Require exactly one visible, exact-name matching complaint row. Similar names
   or multiple matches must not be chosen automatically.
6. Extract that row's stable complaint ID and check its selection checkbox.
   Checking preserves an already-checked selection; clicking could toggle it off.
7. Confirm the selection and require the HPI editor's active complaint ID to match.
8. Recheck that ID immediately before entering the attested HPI narrative and
   again before saving. Preserve the existing clinical-text conflict check.
9. Save a draft only, reopen the exact encounter, select the same Wellness Exam
   complaint, and verify the retained HPI narrative in that complaint's field.

The implementation is in `src/integrations/prognocis-browser.mjs`:
`selectHpiComplaint()`, `assertSelectedHpiComplaint()`, `writeMissingSections()`,
and `process()`. Complaint-selection failure must stop HPI entry, not fall back
to another complaint, a free-text match, or a different note slot.

## Live selector configuration

### Wellness exam / HPI (captured with Playwright MCP, 2026-09-18)

The user selected Wellness exam and focused `#msPth_curcmp_notes`; this live
textarea was editable and empty. The active `#msCurrentComplaintId` matched
the ID of the unique exact Wellness exam lookup result (the ID is not recorded
here). Reopening the lookup confirmed these selectors, now in the private
active config:

| Control | Selector |
| --- | --- |
| Complaint lookup | `#searchCompl` |
| Search input | `#CMP_NAME` |
| Result rows | `tr[id^="rownum"][onclick*="sendCODE("]` |
| Exact complaint name within row | `td:nth-child(1)` |
| Selection within row | `input[type="checkbox"]` |
| Lookup confirmation | `#ok` (scoped to lookup page/frames) |
| Active complaint ID | `#msCurrentComplaintId` |
| HPI narrative | `#msPth_curcmp_notes` |
| HPI save | `#ok` (scoped to HPI section frame) |

The user demonstrated the binocular control: it is `#searchCompl`, invoking
`addComplaint()`. Opening HPI alone does not open the complaint popup. The writer
waits for this control in the HPI frame before a single click; if the complaint
search is already visible in the intended site's browser context, it reuses it
without navigating HPI or opening a second popup.

The result `onclick` invokes `sendCODE`; its second quoted argument is the
complaint ID. Search uses the existing keyup-triggered flow. Selector discovery
did not enter or save note text. Writes remain disabled pending the operator
acknowledgement and the configured source acknowledgement endpoint.

### Encounter History provider (captured with Playwright MCP, 2026-09-18)

The live `patenclist` history table has `#td_MED_DISPLAY_NAME` as its third
header, labelled **Attending Provider**. Data rows use
`tr[id^="rownum"][onclick*="sendCode("]`; the row-relative provider selector is
`td:nth-child(3)`. This is set in the private active configuration as
`prognocis.selectors.encounterProviderCell`. Date, type, and status remain
columns 1, 2, and 5 respectively. No patient or encounter values are recorded
here. Provider matching remains mandatory when supplied by the API.

Keep `prognocis.hpiComplaintName` set to `Wellness exam`. Capture these controls
from the authorized patient's HPI screen and its complaint lookup:

- `hpiMenu`, `hpiField`, and `hpiSaveButton`.
- `hpiComplaintLookupButton` and `hpiComplaintSearchInput`.
- `hpiComplaintRows` and `hpiComplaintNameCell`.
- `hpiComplaintSelectButton` (the checkbox within the exact result row).
- `hpiComplaintConfirmButton` and `hpiActiveComplaintId`.
- `prognocis.hpiComplaintIdAttribute` and its `hpiComplaintIdPattern`.

Selectors used by synthetic fixtures are not proof of the current live DOM.
Do not substitute guessed selectors into the production config. The active
configuration keeps writes disabled until live selector capture and the
supervised draft canary are complete.

## Playwright MCP inspection and noVNC

Playwright MCP is connected to the writer's Chrome through localhost CDP `9223`.
Inspection suppresses automatic page snapshots and returns only control metadata,
not credentials, patient names/IDs, or note text. No live note is saved during
selector discovery. Open an authorized test patient's existing HPI encounter
through the logged-in desktop before capturing complaint controls.

The noVNC service is available on server-local port `6080`:

```text
http://127.0.0.1:6080/vnc.html?autoconnect=true&resize=scale&path=websockify
```

The laptop requires the corresponding VS Code Remote SSH port forward. An
open-external request was sent through the active VS Code connection; laptop
reachability must still be checked by the user. If the link does not open, forward
remote port `6080` in the Ports panel and use its displayed local address.
Never expose CDP or the remote clinical desktop publicly or embed its password
in a link.

## Verification

Note inspection uses an atomic field read. If PrognoCIS destroys the execution
context or replaces a section iframe, `readSection()` reacquires the field in
the configured section frame and waits for its DOM within a bounded deadline.
Recovery does not re-click the section menu, enter text, or retry saves. A
closed page, unrelated error, or unstable frame stops the operation; conflicting
existing text still stops writing. Regression coverage includes an actual
replaced iframe and a second reload while awaiting DOM readiness.

Synthetic Chromium tests cover exact selection, missing/ambiguous rows,
confirmation that fails to activate the complaint, already-active checked and
unchecked choices, an active-ID change that blocks HPI entry, and a real popup
selection that unlocks HPI and retains the saved narrative after a fresh reopen.
These tests are not a production EHR canary.
