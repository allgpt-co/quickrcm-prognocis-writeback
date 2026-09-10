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

test('Playwright joins rendered queue, patient, appointment, and accepted-coding pages', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('wasp:sessionId', JSON.stringify('fixture-session'));
    });
    await page.route('https://quickrcm.example.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/operations/get-coding-job-by-id') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ json: {
            id: 'code-3',
            organizationId: 'organization-3',
            appointmentId: 'appointment-3',
            scribeJobId: 'job-3',
            status: 'COMPLETED',
            appointment: {
              id: 'appointment-3',
              organizationId: 'organization-3',
              appointmentType: 'Follow-up',
              startTime: '2026-09-05T15:30:00.000Z',
              patient: {
                firstName: 'Sample', lastName: 'Patient', mrn: 'MRN-3'
              }
            },
            scribeJob: { id: 'job-3' },
            extractedData: {
              acceptedCodes: ['R05.9'],
              agent2: { icd_codes: [
                { code: 'R05.9', description: 'Cough, unspecified' },
                { code: 'J06.9', description: 'Suggestion only' }
              ] }
            }
          } })
        });
        return;
      }
      if (pathname === '/scribe/encounters') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app"><table><tbody>
            <tr onclick="location.href='/scribe/encounters/job-3'">
              <td><p class="patient">Sample Patient</p></td><td class="mrn">MRN-3</td>
              <td class="date">Sep 4, 2026</td><td></td><td></td><td class="status">Attested</td>
            </tr>
          </tbody></table></main>
        ` });
        return;
      }
      if (pathname === '/ehr/patients') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app"><input placeholder="Search patients..."><table><tbody>
            <tr><td></td><td class="name">Sample Patient</td><td class="dob">01-02-1980</td></tr>
          </tbody></table></main>
        ` });
        return;
      }
      if (pathname === '/scribe/appointments') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app"><input placeholder="Search patient"><table><tbody>
            <tr><td><p class="name">Sample Patient</p><p class="mrn">MRN MRN-3</p></td>
              <td><p class="type">Follow-up</p></td><td></td><td></td><td>Completed</td><td><button>Review note</button></td></tr>
          </tbody></table></main>
        ` });
        return;
      }
      if (pathname === '/medical-coding/outpatient-billing/code-3') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app"><ul><li class="suggested"><input aria-label="diagnosis code" value="R05.9">
            <input aria-label="diagnosis description" value="Cough, unspecified"><button>Needs review</button>
          </li></ul></main>
        ` });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: `
        <main id="app"><section id="detail"><span id="detail-status">Attested</span>
          <time id="attested-at">Sep 4, 2026, 2:15 PM</time><span id="attested-by">provider-3</span>
          <pre id="final-note">HPI: Cough is improving.\nROS: Respiratory cough; denies fever.\nPhysical Examination: Lungs clear.</pre>
          <button id="codes" onclick="location.href='/medical-coding/outpatient-billing/code-3'">View Generated Codes</button>
        </section></main>
      ` });
    });
    const joinedConfig = {
      url: 'https://quickrcm.example.test',
      attestedNotesUrl: 'https://quickrcm.example.test/scribe/encounters',
      noteIdUrlPattern: '^/scribe/encounters/([^/]+)$',
      patientDirectoryUrl: 'https://quickrcm.example.test/ehr/patients',
      appointmentDirectoryUrl: 'https://quickrcm.example.test/scribe/appointments',
      patientNamePattern: '^(.+?)\\s+(\\S+)$',
      diagnosisPageUrlPattern: '^/medical-coding/outpatient-billing/[^/]+$',
      codingJobOperationUrl: 'https://quickrcm.example.test/operations/get-coding-job-by-id',
      appointmentIdByJobId: { 'job-3': 'appointment-3' },
      appointmentTypeMap: { 'Follow-up': 'Follow Up' },
      selectors: {
        authenticatedMarker: '#app',
        noteRows: 'main table tbody tr',
        noteStatus: '.status',
        noteOpenLink: '',
        noteIdAttribute: '',
        queuePatientName: '.patient',
        queuePatientId: '.mrn',
        queueServiceDate: '.date',
        noteDetailRoot: '#detail',
        detailStatus: '#detail-status',
        attestationAt: '#attested-at',
        attestationBy: '#attested-by',
        finalNote: '#final-note',
        patientSearchInput: 'input[placeholder="Search patients..."]',
        patientRows: 'main table tbody tr',
        patientNameCell: '.name',
        patientDobCell: '.dob',
        appointmentSearchInput: 'input[placeholder="Search patient"]',
        appointmentRows: 'main table tbody tr',
        appointmentPatientNameCell: '.name',
        appointmentPatientIdCell: '.mrn',
        appointmentTypeCell: '.type',
        diagnosisOpenButton: '#codes',
        acceptedDiagnosisRows: '.accepted',
        diagnosisCode: 'input[aria-label="diagnosis code"]',
        diagnosisDescription: 'input[aria-label="diagnosis description"]'
      }
    };
    const source = new QuickScribeBrowser(page, joinedConfig);
    const [record] = await source.listAttestedArtifacts(1);
    assert.equal(record.patient.id, 'MRN-3');
    assert.equal(record.patient.dob, '1980-01-02');
    assert.equal(record.encounter.appointmentId, 'appointment-3');
    assert.equal(record.encounter.appointmentType, 'Follow Up');
    assert.equal(record.encounter.startTime, '2026-09-05T15:30:00.000Z');
    assert.equal(record.attestation.at.slice(0, 10), '2026-09-04');
    assert.deepEqual(record.diagnoses.map(({ code }) => code), ['R05.9']);
  } finally {
    await browser.close();
  }
});

test('Playwright rejects a persisted coding job linked to another Scribe job', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('wasp:sessionId', JSON.stringify('fixture-session'));
    });
    await page.route('https://quickrcm.example.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/operations/get-coding-job-by-id') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ json: {
          id: 'code-4',
          organizationId: 'organization-4',
          appointmentId: 'appointment-4',
          scribeJobId: 'different-job',
          status: 'COMPLETED',
          appointment: {
            id: 'appointment-4',
            organizationId: 'organization-4',
            appointmentType: 'Follow-up',
            startTime: '2026-09-05T15:30:00.000Z',
            patient: { firstName: 'Sample', lastName: 'Patient', mrn: 'MRN-4' }
          },
          extractedData: {
            acceptedCodes: ['R05.9'],
            agent2: { icd_codes: [{ code: 'R05.9', description: 'Cough' }] }
          }
        } }) });
        return;
      }
      await route.fulfill({ contentType: 'text/html', body: '<main id="app"></main>' });
    });
    await page.goto('https://quickrcm.example.test/medical-coding/outpatient-billing/code-4');
    const source = new QuickScribeBrowser(page, {
      url: 'https://quickrcm.example.test',
      diagnosisPageUrlPattern: '^/medical-coding/outpatient-billing/[^/]+$',
      codingJobOperationUrl: 'https://quickrcm.example.test/operations/get-coding-job-by-id',
      appointmentIdByJobId: { 'job-4': 'appointment-4' },
      selectors: {}
    });
    await assert.rejects(
      () => source.readPersistedCodingReview({
        jobId: 'job-4', patientId: 'MRN-4', patientName: 'Sample Patient'
      }),
      /does not belong to the attested Scribe job/
    );
  } finally {
    await browser.close();
  }
});

test('Playwright logs into QuickRCM and selects the exact configured organization only when required', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.route('https://quickrcm.example.test/**', async (route) => {
      const requestUrl = new URL(route.request().url());
      const authenticated = (await route.request().allHeaders()).cookie?.includes('auth=yes');
      if ((requestUrl.pathname === '/attested' && !authenticated)
        || requestUrl.pathname === '/login') {
        await route.fulfill({ contentType: 'text/html', body: `
          <form id="login-form" hidden>
            <input type="email" name="email"><input type="password" name="password">
            <button type="submit">Log in</button>
          </form>
          <script>
            setTimeout(() => {
              const form = document.querySelector('#login-form');
              form.hidden = false;
              form.addEventListener('submit', (event) => {
                event.preventDefault();
                if (event.target.email.value === 'quick@example.test'
                  && event.target.password.value === 'quick-secret') {
                  document.cookie = 'auth=yes; Path=/';
                  location.href = '/dashboard';
                }
              });
            }, 150);
          </script>
        ` });
        return;
      }
      if (requestUrl.pathname === '/dashboard') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app">
            <button id="organization-trigger" role="combobox"><span id="current-org"></span></button>
            <div id="organization-options" hidden>
              <button role="option" data-value="org-other">Other Organization</button>
              <button role="option" data-value="org-1960">1960pacare</button>
            </div>
          </main>
          <script>
            const current = document.querySelector('#current-org');
            current.textContent = localStorage.getItem('currentOrgId') === 'org-1960'
              ? '1960pacare' : 'Other Organization';
            document.querySelector('#organization-trigger').onclick = () => {
              document.querySelector('#organization-options').hidden = false;
            };
            for (const option of document.querySelectorAll('[role="option"]')) {
              option.onclick = () => {
                localStorage.setItem('currentOrgId', option.dataset.value);
                location.reload();
              };
            }
          </script>
        ` });
        return;
      }
      if (requestUrl.pathname === '/attested') {
        await route.fulfill({ contentType: 'text/html', body: `
          <main id="app"><div class="note-row" data-job-id="job-login">
            <span class="status">ATTESTED</span><a class="open" href="/jobs/job-login">Open</a>
          </div></main>
        ` });
        return;
      }
      await route.fulfill({ status: 404, body: 'not found' });
    });
    const loginConfig = {
      url: 'https://quickrcm.example.test',
      loginUrl: 'https://quickrcm.example.test/login',
      attestedNotesUrl: 'https://quickrcm.example.test/attested',
      organizationName: '1960pacare',
      selectors: {
        authenticatedMarker: '#app',
        loginMarker: 'input[name="password"]',
        loginEmail: 'input[name="email"]',
        loginPassword: 'input[name="password"]',
        loginSubmit: 'button[type="submit"]',
        organizationTrigger: '#organization-trigger',
        organizationOptions: '#organization-options [role="option"]',
        noteRows: '.note-row',
        noteStatus: '.status',
        noteOpenLink: 'a.open',
        noteIdAttribute: 'data-job-id'
      }
    };
    const source = new QuickScribeBrowser(page, loginConfig, {
      email: 'quick@example.test', password: 'quick-secret'
    });
    const targets = await source.listAttestedTargets(1);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].jobId, 'job-login');
    assert.equal(await page.evaluate(() => localStorage.getItem('currentOrgId')), 'org-1960');
  } finally {
    await browser.close();
  }
});

test('QuickRCM automatic login fails closed when the exact credential env values are absent', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent('<input type="password" name="password">');
    const source = new QuickScribeBrowser(page, {
      url: 'https://quickrcm.example.test',
      loginUrl: 'https://quickrcm.example.test/login',
      attestedNotesUrl: 'https://quickrcm.example.test/attested',
      organizationName: '1960pacare',
      selectors: {
        loginMarker: 'input[name="password"]',
        loginEmail: 'input[name="email"]',
        loginPassword: 'input[name="password"]',
        loginSubmit: 'button[type="submit"]',
        authenticatedMarker: '#app',
        organizationTrigger: '#organization-trigger',
        organizationOptions: '[role="option"]'
      }
    }, {});
    await assert.rejects(() => source.assertAuthenticated(), /Quick_rcm_email.*Quick_rcm_password/);
  } finally {
    await browser.close();
  }
});
