import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';
import { buildClinicalArtifact } from '../src/domain/clinical-artifact.mjs';
import { artifactsFromApiResponse } from '../src/integrations/care1960-api.mjs';

const sqlResponse = JSON.parse(await fs.readFile(
  new URL('../test-support/fixtures/care1960-0010-response.json', import.meta.url)
));

for (const scenario of [
  { name: 'full narratives', note: sqlResponse[0].note },
  { name: 'placeholder narratives', note: { hpi: sqlResponse[0].note.hpi, ros: 'Not documented', physical_examination: 'Not documented' } },
  { name: 'null and blank sections', note: { hpi: sqlResponse[0].note.hpi, ros: null, physical_examination: ' \n\t ' } },
  { name: 'all sections empty', note: { hpi: null, ros: '', physical_examination: null } },
  { name: 'heading-only sections', note: { hpi: '## HPI', ros: 'ROS:', physical_examination: 'Physical Examination:' } }
]) {
test(`${scenario.name} survive Playwright save/read-back, replay without writes, and preserve conflicting EHR text`, async () => {
  const response = structuredClone(sqlResponse);
  response[0].note = scenario.note;
  const executablePath = await resolveChromiumExecutable({
    projectRoot: process.cwd(),
    executablePath: process.env.PROGNOCIS_TEST_CHROMIUM_EXECUTABLE ?? ''
  });
  assert.ok(executablePath, 'An installed Chromium executable is required for browser fixtures');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    const saved = { hpi: '', ros: '', physicalExamination: '' };
    const writes = [];
    await page.route('https://ehr.example.test/**', async (route) => {
      if (route.request().method() === 'POST') {
        const { section, value } = route.request().postDataJSON();
        if (section !== 'draft') saved[section] = value;
        writes.push(section);
        return route.fulfill({ json: { saved: true } });
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <div id="ready">Ready</div><div id="status">Draft</div>
        <input id="active-complaint" type="hidden" value="958">
        ${Object.keys(saved).map((section) => `
          <button id="${section}-menu">${section}</button>
          <textarea id="${section}">${saved[section]}</textarea>
          <button id="${section}-save" onclick="save('${section}')">Save</button>
        `).join('')}
        <button id="draft-save" onclick="save('draft')">Save Draft</button>
        <script>
          async function save(section) {
            await fetch('/save', { method: 'POST', headers: {'Content-Type':'application/json'},
              body: JSON.stringify({section, value: document.getElementById(section)?.value}) });
          }
        </script>
      ` });
    });
    const selectors = { draftStatus: '#status', saveDraftButton: '#draft-save', hpiActiveComplaintId: '#active-complaint' };
    for (const section of Object.keys(saved)) {
      selectors[`${section}Menu`] = `#${section}-menu`;
      selectors[`${section}Field`] = `#${section}`;
      selectors[`${section}SaveButton`] = `#${section}-save`;
    }
    const destination = new PrognocisBrowser(page, {
      url: 'https://ehr.example.test/encounter', selectors,
      sectionSaveUrlPattern: '/save$', draftSaveUrlPattern: '/save$',
      editableStatusPattern: '^Draft$', draftStatusPattern: '^Draft$'
    }, { timezone: 'America/Chicago' });
    // Identity navigation is covered by the existing matching/browser fixtures.
    // The actual section save, reload, inspection, and duplicate path run here.
    destination.open = async () => {};
    destination.selectHpiComplaint = async () => {
      destination.selectedHpiComplaintId = '958';
      return '958';
    };
    destination.selectPatient = async (patient) => {
      assert.equal(patient.prognocisPatientId, sqlResponse[0].patient.prognocis_patient_id);
      assert.equal(patient.firstName, sqlResponse[0].patient.first_name);
      assert.equal(patient.dob, sqlResponse[0].patient.date_of_birth);
    };
    destination.openExactEncounter = async (encounter) => {
      assert.equal(encounter.prognocisEncounterId, sqlResponse[0].appointment.prognocis_encounter_id);
      assert.equal(encounter.appointmentType, sqlResponse[0].appointment.appointment_type);
      return encounter.prognocisEncounterId;
    };
    destination.readDiagnoses = async () => assert.fail('Care1960 must not visit the diagnosis UI');
    destination.addDiagnosis = async () => assert.fail('Care1960 must not write diagnoses');
    const [artifact] = artifactsFromApiResponse(response, { orgId: sqlResponse[0].org_id });
    const populated = Object.keys(saved).filter((section) => artifact.sections[section] !== '');
    const expectedWrites = populated.length ? [...populated, 'draft'] : [];
    const first = await destination.process(artifact, { writeEnabled: true });
    assert.equal(first.status, 'DRAFT_VERIFIED');
    assert.equal(first.duplicate, populated.length === 0);
    assert.deepEqual(saved, artifact.sections);
    assert.deepEqual(saved, {
      hpi: scenario.note.hpi?.trim() ?? '',
      ros: scenario.note.ros?.trim() ?? '',
      physicalExamination: scenario.note.physical_examination?.trim() ?? ''
    });
    assert.deepEqual(writes, expectedWrites);
    const second = await destination.process(artifact, { writeEnabled: true });
    assert.equal(second.duplicate, true);
    assert.deepEqual(writes, expectedWrites);
    saved.ros = 'Existing clinician ROS must be preserved.';
    for (const incoming of [null, 'Not documented', 'Different reviewed ROS.']) {
      const changed = buildClinicalArtifact({ ...artifact, sections: { ...artifact.sections, ros: incoming } });
      await assert.rejects(destination.process(changed, { writeEnabled: true }), /refusing overwrite/);
      assert.deepEqual(writes, expectedWrites);
      assert.equal(saved.ros, 'Existing clinician ROS must be preserved.');
    }
  } finally {
    await browser.close();
  }
});
}
