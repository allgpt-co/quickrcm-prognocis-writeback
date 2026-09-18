# Doctor Screen-Recording Guide: QuickRCM → QuickScribe → PrognoCIS

**Prepared:** September 7, 2026 (America/Chicago)  
**Environment:** development/test only  
**Patient:** synthetic only

> **Important: do not start the final recording yet.** While checking the live noVNC browser, I found a QuickScribe multi-organization routing bug described under **Current blocker** below. The appointment is correctly created, but this login will probably receive **Appointment not found** when `Start` is clicked until the tenant issue is fixed or a single-organization doctor login is used.

---

## 1. What is already completed

### PrognoCIS source record

- Patient: **Demoaudio Testsep07**
- DOB: **01/01/1990**
- Chart/MRN: **GMC22069**
- PrognoCIS patient ID: `21104`
- PrognoCIS appointment ID: `189231`
- Appointment: **09/08/2026 at 4:00 PM**
- Type: **Follow-Up VISIT**
- Provider: **Jesus Mayor M.D.**
- Location: **Clinic**
- Reason: **SYNTHETIC AUDIO E2E TEST**

### QuickRCM organization setup

- Selected organization: **1960pacare**
- Synthetic test provider is configured.
- Synthetic facility **Synthetic Test Clinic** is configured.
- Patient **Demoaudio Testsep07** exists once.
- QuickRCM patient ID: `7ffb9e26-7e9a-4a68-9278-3e8e20eb9b6c`
- MRN: **GMC22069**
- Appointment exists once for **09/08/2026, 4:00–4:15 PM**.
- Appointment type: **Follow-up**
- Appointment status: **Scheduled**
- QuickRCM appointment ID: `57e63dc3-4d57-442a-9cd5-f410783ddb34`
- The QuickScribe encounter page is open and currently shows **READY TO START**.
- No recording has been started.
- No Scribe job has been created.
- No note has been generated or attested.
- Nothing has been written back for this new test yet.

### Important honesty statement for the video

This QuickRCM appointment was **manually created** in the new organization. Therefore, this recording can honestly prove:

```text
QuickRCM appointment
→ live synthetic recording
→ QuickScribe note and human attestation
→ reverse script
→ correct open PrognoCIS encounter updated
```

It does **not** prove that the forward PrognoCIS → QuickRCM job created this particular appointment. Do not call this video proof of the automated forward synchronization.

---

## 2. Current blocker found in the live browser

The header and browser storage correctly identify the selected organization as **1960pacare**. However, the deployed QuickScribe server operations are resolving this multi-organization login to a different older organization named **Test**.

Evidence observed without starting a recording:

- Current QuickRCM organization: `1960pacare`
- Appointment belongs to the `1960pacare` organization.
- `get-scribe-templates` returned templates belonging to the older `Test` organization.
- A temporary diagnostic template was consequently created in `Test`; I deleted it immediately, so no unwanted template remains.
- `get-encounter-status` returned no encounter for the new appointment.
- The deployed `startEncounter` implementation searches for the appointment in the server-resolved organization. With this mismatch it will return **Appointment not found**.

### Safe ways to unblock the video

Use one of these before clicking **Start**:

1. **Recommended:** fix/deploy the QuickScribe organization-scoping bug so every Scribe operation receives and uses the selected `organizationId`.
2. **Fast recording workaround:** log in as an authorized doctor/test user whose **only organization membership is 1960pacare**.

Do not record the encounter under the old `Test` organization and present it as a `1960pacare` encounter.

---

## 3. One-time setup before starting the screen recorder

Do these off camera unless you want the setup included.

1. Open the noVNC Chrome window.
2. Log in to QuickRCM with the authorized doctor/test account.
3. At the organization picker in the top header, select **1960pacare**.
4. Confirm the header visibly says **1960pacare** before touching the patient.
5. Confirm the login has the tenant-routing fix or is a single-organization account.
6. Confirm the browser microphone is connected and permitted.
7. Close password-manager popups, notifications, unrelated tabs, and anything containing credentials or real PHI.
8. Keep only the QuickRCM and PrognoCIS test tabs needed for the demonstration.
9. Use only synthetic spoken content.

### Create the correct Scribe template once

The reverse script requires three explicit, nonempty clinical headings: **HPI**, **ROS**, and **Physical Examination**. The existing `Problem-Focused Follow-up (SOAP)` template is not sufficient because it normally produces only Subjective/Objective/Assessment/Plan.

After the tenant routing is corrected:

1. In the left sidebar, click **AI Scribe**.
2. Click **Templates**.
3. Click **New Template**.
4. In **Template Name**, enter:
   `PrognoCIS Follow-up Write-Back`
5. In **Template Sections**, enter exactly:
   `Chief Complaint, HPI, ROS, Physical Examination, Assessment, Plan`
6. In **Specialty**, enter:
   `Primary Care`
7. Click **Save Template**.
8. Confirm the new template card appears while the header still says **1960pacare**.

This template should be created before the final recording so the clinical demonstration is clean.

---

## 4. Exact QuickRCM doctor flow to record

### Scene A — Establish patient and appointment identity

1. Start your screen recorder.
2. In QuickRCM, show the top organization picker reading **1960pacare**.
3. In the left sidebar, click **AI Scribe**.
4. In the expanded Scribe menu, click **Appointments**.
5. At the top of the Appointments page, click **Tomorrow**.
6. Find the single row showing:
   - **Demoaudio Testsep07**
   - **MRN GMC22069**
   - **4:00 PM–4:15 PM**
   - **Follow-up**
   - **Synthetic Test Provider**
   - **Synthetic Test Clinic**
   - status **scheduled**
7. Pause for two seconds so the correlation fields are visible in the video.
8. Click **Start encounter** on this row.

### Scene B — Confirm you opened the correct encounter

The Encounter page should show:

- **Demoaudio Testsep07**
- **MRN: GMC22069**
- **DOB: 01/01/1990**
- status **READY TO START**
- timer `--:--`
- buttons **Start**, **Process**, and **Select Template**

Do not continue if the patient, MRN, or DOB is different.

### Scene C — Select the write-back-safe template

1. Click **Select Template**.
2. Choose **PrognoCIS Follow-up Write-Back**.
3. Confirm the chosen template name appears on the Encounter page.
4. Do this before clicking **Start**.

### Scene D — Start the live synthetic recording

1. Click **Start**.
2. If Chrome asks for microphone access, click **Allow**.
3. Confirm all of the following appear:
   - **RECORDING...**
   - the timer starts increasing;
   - the waveform changes from **No audio activity**.
4. Speak only the approved synthetic encounter.

For the reverse script to pass, make sure your synthetic narration supplies substantive content for all three destination fields:

- **HPI** — symptoms, onset/duration, course, and context.
- **ROS** — relevant positive and negative systems.
- **Physical Examination** — actual synthetic examination findings.
- Also state an assessment and plan so medical coding has enough context.

Do not use a real patient's name, DOB, MRN, address, diagnosis, or recording.

### Scene E — Stop and process

1. When the narration is complete, click **Stop**.
2. Wait for the **Recording stopped** message.
3. Do **not** refresh, close the tab, or navigate away: the stopped audio blob exists in this browser page until upload.
4. Confirm the template is still selected.
5. Confirm **Process** is enabled.
6. Click **Process** once.
7. QuickScribe will perform these stages:
   - upload the audio;
   - transcribe it;
   - generate the clinical note.
8. Keep the page open. The encounter page polls job status about every **2 seconds** while its status is `UPLOADING`, `TRANSCRIBING`, or `GENERATING_NOTE`.
9. Wait for **Encounter Complete** and **Ready**. Do not repeatedly click Process.

If processing fails, leave the page open and capture the exact error. Do not create another patient or duplicate appointment.

---

## 5. Provider review before attestation

When processing finishes, the Encounter page displays these tabs:

- **Clinical Note**
- **Transcript**
- **Recording**

### Required review

1. Stay on **Clinical Note**.
2. Read the full generated note against the synthetic recording.
3. Confirm these headings occur exactly once and have meaningful content:
   - `HPI:`
   - `ROS:`
   - `Physical Examination:`
4. Confirm none of those sections is blank or says only `N/A`, `None`, `Unknown`, or `Not documented`.
5. Confirm the assessment and plan accurately reflect what you actually recorded.
6. Optionally click **Transcript** and show that the narration was transcribed.
7. Optionally click **Recording** to show the stored session recording.

### Correct the note if required

Only the authorized provider should make and approve clinical changes.

1. Click **Edit Note**.
2. Correct the note in the text area.
3. Preserve these exact standalone headings:

```text
HPI:
<substantive synthetic history>

ROS:
<substantive synthetic review of systems>

Physical Examination:
<substantive synthetic examination findings>

Assessment:
<provider-reviewed assessment>

Plan:
<provider-reviewed plan>
```

4. Click **Save Changes**.
5. Wait for **Note saved successfully**.
6. Read the rendered note again after saving.

Do not attest until the provider is satisfied that it is correct.

---

## 6. Generate and accept the ICD-10-CM diagnosis

The reverse script intentionally refuses notes with no explicitly human-accepted ICD-10-CM diagnosis. Do this while the encounter is still **Completed**, before attesting.

1. On the completed Encounter page, click **Generate Medical Codes**.
2. Wait for **Code generation started**. The UI moves to **Medical Coding**.
3. Open the new coding job for **Demoaudio Testsep07**.
4. Wait until code generation is complete.
5. Review the AI-suggested codes against the provider-approved synthetic note.
6. In **AI Suggested Codes**, find the intended **ICD-10** diagnosis.
7. Click the check-mark **Accept code** button for the correct ICD-10 code.
8. Confirm that code visibly changes to **Accepted**.
9. Accept at least one ICD-10-CM diagnosis, but accept only what the doctor has reviewed.
10. Do **not** send a claim, submit a claim, or use **Accept and Send to Claims** for this write-back demonstration.
11. Return to **AI Scribe → Encounters** and open the matching encounter for **Demoaudio Testsep07**.

The write-back reads only diagnoses whose UI state is explicitly **Accepted**. Suggested, rejected, CPT, HCPCS, and unreviewed codes are ignored.

---

## 7. Attest and end the first video segment

Attestation is a provider-only action and cannot be delegated to the automation.

1. Reopen the matching completed Scribe encounter.
2. Recheck the patient name, MRN, date, note, and accepted ICD-10 diagnosis.
3. Click **Attest & sign**.
4. A browser confirmation appears stating that you reviewed the note and that attestation finalizes it so it cannot be edited.
5. Only if that statement is true, click **OK**.
6. Wait for **Note attested**.
7. Go to **AI Scribe → Encounters**.
8. Show the row for **Demoaudio Testsep07** with status **Attested**.
9. Open it and show the attested timestamp/actor if visible.
10. Stop the first screen-recording segment here.

The reverse script does not trigger merely because recording or processing finished. It accepts the source only after the durable status is exactly **ATTESTED**.

---

## 8. Before running the reverse script

After attestation, tell me **attested**. I must first capture the new stable QuickScribe job ID and add this private mapping to the ignored live configuration:

```text
<new QuickScribe job ID> → 57e63dc3-4d57-442a-9cd5-f410783ddb34
```

Do not begin the terminal video before that mapping is updated and both websites are authenticated.

Then verify:

1. QuickRCM is logged in to the correct organization.
2. PrognoCIS is logged in.
3. Only one active PrognoCIS application window exists.
4. The PrognoCIS encounter for appointment `189231` is still **Open**.
5. The QuickScribe source shows **Attested** and at least one accepted ICD-10-CM diagnosis.

---

## 9. Terminal commands for the second video segment

From a terminal in this workspace:

```bash
cd /quickintell/workspaces/anurag_workspace/quickrcm-prognocis-writeback
```

### Step 1 — configuration validation

```bash
npm run validate:config -- --config config/writeback.json
```

Expected:

```text
Configuration is structurally valid.
```

### Step 2 — read-only probe

```bash
npm run probe -- --config config/writeback.json --max-records 1
```

The probe must find exactly the intended attested record and exact PrognoCIS encounter with zero failures. It does not write clinical fields.

Stop if it reports authentication required, zero/multiple patient matches, zero/multiple encounter matches, missing HPI/ROS/Physical Examination, or no accepted diagnosis.

### Step 3 — one-record live draft write

```bash
CLINICAL_WRITE_ACK=I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES \
  npm run run -- --config config/writeback.json --max-records 1
```

A successful first result should contain:

```json
{"mode":"draft-write","queued":1,"probed":0,"verified":1,"skipped":0,"duplicates":0,"failed":0}
```

`verified: 1` means the script saved the allowed clinical draft fields, reopened them, read them back, revalidated the unchanged attested source, and stored PHI-free completion proof.

### Step 4 — optional idempotency proof

Run the same live command a second time. For this one-record test, the expected result is:

```json
{"mode":"draft-write","queued":1,"probed":0,"verified":0,"skipped":1,"duplicates":0,"failed":0}
```

This proves the same attested artifact is not written twice.

Do not display `.env`, cookies, browser storage, credentials, or the private configuration file in the video.

---

## 10. Final PrognoCIS proof segment

After the script reports `verified: 1`:

1. Return to the existing PrognoCIS application tab.
2. Search for **Demoaudio Testsep07**.
3. Confirm chart/MRN **GMC22069** and DOB **01/01/1990**.
4. Open the retained **09/08/2026 Follow-Up VISIT** encounter.
5. Confirm it is the same appointment/encounter associated with appointment ID `189231`.
6. Open **HPI** and show the synthetic HPI written from the attested note.
7. Open **ROS** and show the synthetic Review of Systems.
8. Open **Physical Examination** and show the synthetic examination findings.
9. Open **Assessment/Diagnosis** and show the accepted ICD-10-CM diagnosis.
10. Show that the encounter status remains **Open**/editable draft.
11. If you ran the idempotency test, show that there is no duplicated diagnosis or duplicated clinical text.

Never click **Sign**, **Finalize**, **Close**, **Electronically Attest**, or **Send to Claims** in PrognoCIS.

---

## 11. Recording checklist

- [ ] Correct organization visible: **1960pacare**
- [ ] Tenant-routing blocker fixed or single-org doctor account used
- [ ] Synthetic patient and appointment identity shown
- [ ] Correct custom template selected
- [ ] Live recording starts; timer and waveform shown
- [ ] Recording stops before Process
- [ ] Processing reaches Encounter Complete
- [ ] Provider reviews HPI, ROS, Physical Examination, Assessment, and Plan
- [ ] At least one ICD-10-CM code is explicitly accepted
- [ ] Provider manually clicks **Attest & sign** and confirms
- [ ] Encounters list visibly shows **Attested**
- [ ] New Scribe job-to-appointment mapping added privately
- [ ] Config validation passes
- [ ] Read-only probe passes
- [ ] Live run reports `verified: 1` and `failed: 0`
- [ ] PrognoCIS HPI, ROS, Physical Examination, and ICD-10 are shown
- [ ] PrognoCIS encounter remains **Open**
- [ ] Optional second run reports `skipped: 1`
- [ ] No credentials, real PHI, or private configuration appears

## Immediate next step

Do **not** click **Start** yet. First either deploy the QuickScribe selected-organization fix or provide/log in with an authorized doctor test account whose only membership is **1960pacare**. Once that is done, the live recording can follow the exact sequence above.
