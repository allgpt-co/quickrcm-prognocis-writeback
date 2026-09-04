import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { QuickScribeBrowser } from '../src/integrations/quickscribe-browser.mjs';

const config = {
  url: 'https://quickrcm.example.test',
  attestedNotesUrl: 'https://quickrcm.example.test/attested',
  selectors: {
    authenticatedMarker: '#app',
    noteRows: '.note-row',
    noteStatus: '.status',
    noteOpenLink: 'a.open',
    noteIdAttribute: 'data-job-id',
    noteDetailRoot: '#note-detail',
    detailStatus: '#detail-status',
    patientId: '#patient-id',
    patientFirstName: '#first-name',
    patientLastName: '#last-name',
    patientDob: '#dob',
    appointmentId: '#appointment-id',
    serviceDate: '#service-date',
    appointmentType: '#appointment-type',
    providerName: '#provider',
    attestationAt: '#attested-at',
    attestationBy: '#attested-by',
    finalNote: '#final-note',
    acceptedDiagnosisRows: '.diagnosis.accepted',
    diagnosisCode: '.code',
    diagnosisDescription: '.description'
  }
};

test('Playwright extracts only an ATTESTED note and accepted ICD-10 rows from the rendered UI', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('https://quickrcm.example.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/attested') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app">
            <div class="note-row" data-job-id="job-ignored"><span class="status">COMPLETED</span><a class="open" href="/jobs/job-ignored">Open</a></div>
            <div class="note-row" data-job-id="job-1"><span class="status">ATTESTED</span><a class="open" href="/jobs/job-1">Open</a></div>
          </main>
        ` });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: `
        <main id="app">
          <article id="note-detail" data-job-id="job-1">
            <span id="detail-status">ATTESTED</span>
            <span id="patient-id">patient-1</span><span id="first-name">Sample</span><span id="last-name">Patient</span><span id="dob">01/02/1980</span>
            <span id="appointment-id">appointment-1</span><span id="service-date">09/04/2026</span><span id="appointment-type">Follow Up</span><span id="provider">Dr Example</span>
            <time id="attested-at">2026-09-04T17:00:00.000Z</time><span id="attested-by">provider-1</span>
            <pre id="final-note">HPI: Cough is improving.
ROS: Respiratory cough; denies fever.
Physical Examination: Lungs clear.</pre>
            <div class="diagnosis accepted"><span class="code">R05.9</span><span class="description">Cough, unspecified</span></div>
            <div class="diagnosis suggested"><span class="code">J06.9</span><span class="description">Suggestion only</span></div>
          </article>
        </main>
      ` });
    });
    const source = new QuickScribeBrowser(page, config);
    const records = await source.listAttestedArtifacts(10);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'ATTESTED');
    assert.equal(records[0].sections.hpi, 'Cough is improving.');
    assert.equal(records[0].sections.ros, 'Respiratory cough; denies fever.');
    assert.equal(records[0].sections.physicalExamination, 'Lungs clear.');
    assert.deepEqual(records[0].diagnoses.map(({ code }) => code), ['R05.9']);
    await assert.doesNotReject(() => source.revalidate(records[0]));
  } finally {
    await browser.close();
  }
});

test('Playwright supports title-case status and row-click navigation with URL-derived identity', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('https://quickrcm.example.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/scribe/encounters') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="main-content">
            <table aria-label="Scribe encounters"><tbody>
              <tr tabindex="0" onclick="location.href='/scribe/encounters/job-ignored'"><td>Ignored</td><td class="status">Completed</td></tr>
              <tr tabindex="0" onclick="location.href='/scribe/encounters/job-2'"><td>Target</td><td class="status">Attested</td></tr>
            </tbody></table>
          </main>
        ` });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: `
        <main id="main-content">
          <span id="detail-status">Attested</span>
          <span id="patient-id">patient-2</span><span id="first-name">Sample</span><span id="last-name">Patient</span><span id="dob">01/02/1980</span>
          <span id="appointment-id">appointment-2</span><span id="service-date">09/04/2026</span><span id="appointment-type">Follow Up</span><span id="provider">Dr Example</span>
          <time id="attested-at">2026-09-04T17:00:00.000Z</time><span id="attested-by">provider-1</span>
          <pre id="final-note">HPI: Cough is improving.\nROS: Respiratory cough; denies fever.\nPhysical Examination: Lungs clear.</pre>
          <div class="diagnosis accepted"><span class="code">R05.9</span><span class="description">Cough, unspecified</span></div>
        </main>
      ` });
    });
    const rowClickConfig = {
      ...config,
      attestedNotesUrl: 'https://quickrcm.example.test/scribe/encounters',
      noteIdUrlPattern: '^/scribe/encounters/([^/]+)$',
      selectors: {
        ...config.selectors,
        authenticatedMarker: '#main-content',
        noteRows: 'table[aria-label="Scribe encounters"] tbody tr',
        noteStatus: '.status',
        noteOpenLink: '',
        noteIdAttribute: '',
        noteDetailRoot: '#main-content'
      }
    };
    const source = new QuickScribeBrowser(page, rowClickConfig);
    const records = await source.listAttestedArtifacts(10);
    assert.equal(records.length, 1);
    assert.equal(records[0].jobId, 'job-2');
    assert.equal(records[0].status, 'ATTESTED');
    await assert.doesNotReject(() => source.revalidate(records[0]));
  } finally {
    await browser.close();
  }
});
