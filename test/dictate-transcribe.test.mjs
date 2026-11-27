import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';
import { artifact } from '../test-support/artifact.mjs';

const titles = {
  hpi: 'HPI General', ros: 'Review of Systems', physicalExamination: 'Physical Exam',
  assessment: 'Assessment General', plan: 'Assessment Plan', socialHistory: 'Social History'
};

// Synthetic DOM only: production selectors still require capture from the clinic.
test('Dictate/Transcribe uses the exact five subsections and preserves the save/read-back flow', async (t) => {
  const browser = await chromium.launch({
    headless: true, executablePath: await resolveChromiumExecutable({ projectRoot: process.cwd() })
  });
  t.after(() => browser.close());
  async function setup(t, { failSave, wrongHeading, duplicateTitle, duplicateEditor, droppedSave, initial = {} } = {}) {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    page.setDefaultTimeout(1500);
    const saved = { ...Object.fromEntries(Object.keys(titles).map(key => [key, ''])),
      socialHistory: 'Existing social history', ...initial };
    const writes = [];
    await page.route('https://ehr.example.test/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST') {
        const { section, value } = request.postDataJSON();
        writes.push(section);
        if (section === failSave) return route.fulfill({ status: 500, body: 'Save failed' });
        if (section !== 'draft' && section !== droppedSave) saved[section] = value;
        return route.fulfill({ json: { saved: true } });
      }
      if (url.pathname === '/dictate') {
        const section = url.searchParams.get('section') ?? 'hpi';
        const rows = Object.entries(titles).map(([key, title]) =>
          `<a class="title" href="/dictate?section=${key}">✓ ${title}</a>`).join('<br>');
        // Every subsection reuses the same editor ID after a delayed frame load.
        await new Promise(resolve => setTimeout(resolve, 25));
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
          <nav>${rows}${duplicateTitle ? '<a class="title" href="/dictate">HPI General</a>' : ''}</nav>
          <h2 id="heading">${wrongHeading ? 'Follow Up' : titles[section]} Notes</h2>
          <textarea id="note" onkeyup="document.querySelector('#save').disabled=false"></textarea>
          ${duplicateEditor ? '<textarea id="note"></textarea>' : ''}
          <button id="save" disabled onclick="save()">Save</button>
          <script>
            document.querySelector('#note').value = ${JSON.stringify(saved[section])};
            async function save() {
              await fetch('/dictate', { method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ section: ${JSON.stringify(section)}, value: document.querySelector('#note').value }) });
            }
          </script>` });
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <button id="dictate-menu" onclick="document.querySelector('iframe').src='/dictate'">Dictate Transcribe</button>
        <div id="status">Draft</div>
        <button id="draft-save" onclick="fetch('/draft', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({section:'draft'}) })">Save Draft</button>
        <h2 id="heading">HPI General Notes</h2><textarea id="note">Existing complaint HPI</textarea>
        <iframe></iframe>` });
    });
    const destination = new PrognocisBrowser(page, {
      url: 'https://ehr.example.test/encounter', noteEntryMode: 'dictate-transcribe',
      dictateTranscribeUrlPattern: '/dictate(?:\\?|$)', dictateTranscribeSaveUrlPattern: '/dictate$',
      draftSaveUrlPattern: '/draft$', editableStatusPattern: '^Draft$', draftStatusPattern: '^Draft$',
      sectionLoadTimeoutMs: 750, saveTimeoutMs: 1500,
      selectors: {
        dictateTranscribeMenu: '#dictate-menu', dictateTranscribeTitles: '.title',
        dictateTranscribeHeading: '#heading', dictateTranscribeField: '#note',
        dictateTranscribeSaveButton: '#save', saveDraftButton: '#draft-save', draftStatus: '#status'
      }
    }, { timezone: 'America/Chicago' });
    // Patient/encounter matching is unchanged and covered by existing browser tests.
    destination.open = async () => {};
    destination.selectPatient = async patient => assert.equal(patient.prognocisPatientId, 'ehr-patient-7');
    destination.openExactEncounter = async encounter => encounter.prognocisEncounterId;
    destination.selectHpiComplaint = async () => assert.fail('Must not select a complaint in Dictate/Transcribe');
    destination.assertSelectedHpiComplaint = destination.selectHpiComplaint;
    return { destination, saved, writes, page };
  }

  await t.test('writes all five, reopens, and skips identical text on replay', async t => {
    const { destination, saved, writes, page } = await setup(t);
    const value = artifact();
    assert.equal((await destination.process(value, { writeEnabled: true })).duplicate, false);
    for (const section of Object.keys(value.sections)) assert.equal(saved[section], value.sections[section]);
    assert.equal(saved.socialHistory, 'Existing social history');
    assert.equal(await page.locator('#note').inputValue(), 'Existing complaint HPI');
    assert.deepEqual(writes, [...Object.keys(value.sections), 'draft']);
    assert.equal((await destination.process(value, { writeEnabled: true })).duplicate, true);
    assert.equal(writes.length, 6);
  });
  await t.test('sections-only saving and blank notes retain existing behavior', async t => {
    const { destination, saved, writes } = await setup(t);
    destination.config.draftSaveStrategy = 'sections-only';
    const value = artifact({ sections: { ...artifact().sections, ros: '' } });
    assert.equal((await destination.process(value, { writeEnabled: true })).status, 'DRAFT_VERIFIED');
    assert.equal(saved.ros, '');
    assert.deepEqual(writes, ['hpi', 'physicalExamination', 'assessment', 'plan']);
  });
  for (const scenario of [
    { name: 'existing conflicting text', initial: { plan: 'Existing clinician plan' }, error: /refusing overwrite/ },
    { name: 'wrong active subsection', wrongHeading: true, error: { code: 'DICTATE_TRANSCRIBE_SECTION_NOT_ACTIVE' } },
    { name: 'ambiguous title', duplicateTitle: true, error: /strict mode violation/ },
    { name: 'ambiguous editor', duplicateEditor: true, error: /Ambiguous Dictate\/Transcribe editor/ }
  ]) {
    await t.test(`refuses ${scenario.name} before writing`, async t => {
      const { destination, writes } = await setup(t, scenario);
      await assert.rejects(destination.process(artifact(), { writeEnabled: true }), scenario.error);
      assert.deepEqual(writes, []);
    });
  }
  await t.test('failed save does not verify the draft', async t => {
    const { destination, saved, writes } = await setup(t, { failSave: 'plan' });
    await assert.rejects(destination.process(artifact(), { writeEnabled: true }), /HTTP 500/);
    assert.equal(saved.plan, '');
    assert.equal(writes.includes('draft'), false);
  });
  await t.test('successful HTTP response without persisted text fails reopened read-back', async t => {
    const { destination } = await setup(t, { droppedSave: 'plan' });
    await assert.rejects(destination.process(artifact(), { writeEnabled: true }), { code: 'DRAFT_READBACK_FAILED' });
  });
});
