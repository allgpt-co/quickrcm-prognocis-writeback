import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser, stablePatientId } from '../src/integrations/prognocis-browser.mjs';
import { artifact } from '../test-support/artifact.mjs';

async function launchFixtureBrowser() {
  const executablePath = await resolveChromiumExecutable({
    projectRoot: process.cwd(),
    executablePath: process.env.PROGNOCIS_TEST_CHROMIUM_EXECUTABLE ?? ''
  });
  assert.ok(executablePath, 'An installed Chromium executable is required for browser fixtures');
  return chromium.launch({ headless: true, executablePath });
}

function complaintConfig() {
  return {
    popupTimeoutMs: 250,
    patientSearchTimeoutMs: 250,
    sectionLoadTimeoutMs: 250,
    hpiComplaintName: 'Wellness exam',
    hpiComplaintIdAttribute: 'onclick',
    hpiComplaintIdPattern: "sendCODE\\('(?:[^']*)','([^']+)'",
    selectors: {
      hpiMenu: '#menu_HP',
      hpiComplaintLookupButton: '#searchCompl',
      hpiComplaintSearchInput: '#CMP_NAME',
      hpiComplaintSearchButton: '',
      hpiComplaintRows: '#results tr',
      hpiComplaintNameCell: 'td:nth-child(1)',
      hpiComplaintSelectButton: 'input[type="checkbox"]',
      hpiComplaintConfirmButton: '#ok',
      hpiActiveComplaintId: '#msCurrentComplaintId'
    }
  };
}

async function installComplaintFixture(page, { activate = true, alreadyActive = false, alreadyChecked = false, ambiguous = false, noMatch = false } = {}) {
  await page.setContent(`
    <button id="menu_HP">HPI</button>
    <button id="searchCompl">Search complaint</button>
    <input id="msCurrentComplaintId" type="hidden" value="${alreadyActive ? '958' : '150'}">
    <div id="panel" hidden>
      <input id="CMP_NAME">
      <table><tbody id="results"></tbody></table>
      <button id="ok">OK</button>
    </div>
    <script>
      window.order = [];
      window.sendCODE = () => {};
      menu_HP.addEventListener('click', () => order.push('hpi'));
      searchCompl.addEventListener('click', () => {
        order.push('lookup');
        panel.hidden = false;
      });
      CMP_NAME.addEventListener('keyup', () => {
        order.push('search');
        const row = document.createElement('tr');
        row.id = 'rownum0';
        row.setAttribute('onclick', "sendCODE('cbs0','958','WELLNESS EXAM','748',event)");
        const name = document.createElement('td');
        name.textContent = '${noMatch ? 'Wellness examination follow up' : 'Wellness exam'}';
        const choice = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = ${alreadyChecked};
        checkbox.addEventListener('click', () => order.push('select'));
        choice.append(checkbox);
        row.append(name, choice);
        results.replaceChildren(row);
        if (${ambiguous}) results.append(row.cloneNode(true));
      });
      ok.addEventListener('click', () => {
        order.push('confirm');
        if (${activate ? 'true' : 'false'} && results.querySelector('input')?.checked) {
          msCurrentComplaintId.value = '958';
        }
        panel.hidden = true;
      });
    </script>
  `);
}

test('extracts retained patient ID from legacy search-row onclick', () => {
  assert.equal(
    stablePatientId("javascript:sendCode('PAT-123','Sample')", "sendCode\\('([^']+)'"),
    'PAT-123'
  );
  assert.equal(stablePatientId("javascript:other('PAT-123')", "sendCode\\('([^']+)'"), '');
});

test('an already-open complaint popup is reused without clicking HPI or the binocular again', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page);
    await page.evaluate(() => { document.querySelector('#panel').hidden = false; });
    const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
    await destination.selectHpiComplaint('Follow Up');
    assert.equal(destination.selectedHpiComplaintId, '958');
    assert.deepEqual(await page.evaluate(() => window.order), ['search', 'select', 'confirm']);
  } finally { await browser.close(); }
});

test('HPI navigation waits for the delayed binocular control before opening complaint search', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page);
    await page.evaluate(() => {
      const lookup = document.querySelector('#searchCompl');
      lookup.hidden = true;
      document.querySelector('#menu_HP').addEventListener('click', () => {
        setTimeout(() => { lookup.hidden = false; }, 120);
      });
    });
    const config = complaintConfig();
    config.sectionLoadTimeoutMs = 2000;
    const destination = new PrognocisBrowser(page, config, { timezone: 'America/Chicago' });
    await destination.selectHpiComplaint('Follow Up');
    assert.deepEqual(await page.evaluate(() => window.order), ['hpi', 'lookup', 'search', 'select', 'confirm']);
  } finally { await browser.close(); }
});

test('already-active Wellness exam closes lookup without re-adding it or clearing HPI', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page, { alreadyActive: true, alreadyChecked: false });
    await page.evaluate(() => {
      const notes = document.createElement('textarea');
      notes.id = 'msPth_curcmp_notes';
      notes.value = 'Existing saved HPI.';
      document.body.append(notes);
      document.querySelector('#ok').addEventListener('click', () => { notes.value = ''; });
      const close = document.createElement('button');
      close.id = 'close';
      close.textContent = 'Close';
      close.addEventListener('click', () => {
        window.order.push('close');
        document.querySelector('#panel').hidden = true;
      });
      document.querySelector('#panel').append(close);
    });
    const config = complaintConfig();
    config.selectors.hpiComplaintCloseButton = '#close';
    const destination = new PrognocisBrowser(page, config, { timezone: 'America/Chicago' });
    await destination.selectHpiComplaint('Follow Up');
    await destination.assertSelectedHpiComplaint();
    assert.equal(await page.locator('#msPth_curcmp_notes').inputValue(), 'Existing saved HPI.');
    assert.deepEqual(await page.evaluate(() => window.order), ['hpi', 'lookup', 'search', 'close']);
  } finally { await browser.close(); }
});

test('section-only draft flow never clicks an extra save or menu and still verifies exact unsigned encounter', async () => {
  for (const open of [true, false]) {
    const page = {
      on() {},
      locator() { assert.fail('Section-only completion must not visit another screen or click Save'); }
    };
    const destination = new PrognocisBrowser(page, {
      draftSaveStrategy: 'sections-only', draftStatusPattern: '^Open$',
      selectors: { encounterStatusCell: '.status' }
    }, { timezone: 'America/Chicago' });
    let checked = 0;
    destination.encounterStatusIs = async (_, encounterId, pattern) => {
      checked += 1;
      assert.equal(encounterId, 'ehr-encounter-9');
      assert.equal(pattern, '^Open$');
      return open;
    };
    if (open) await destination.saveDraftAndVerifyStatus(artifact(), 'ehr-encounter-9');
    else await assert.rejects(() => destination.saveDraftAndVerifyStatus(artifact(), 'ehr-encounter-9'), /Draft status/);
    assert.equal(checked, 1);
  }
});

test('Playwright matches the captured third-column attending provider and exact date, type, encounter ID', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="encounter-menu">Encounters</button>
      <div id="editor">Encounter editor</div>
      <table id="encounters"><tbody>
        <tr data-encounter-id="ehr-encounter-8">
          <td class="date">09/04/2026</td><td class="type">Follow Up</td><td class="provider">Dr Example</td>
        </tr>
        <tr data-encounter-id="ehr-encounter-9">
          <td class="date">09/04/2026</td><td class="type">Follow Up</td><td class="provider">Dr Example</td>
        </tr>
        <tr data-encounter-id="ehr-encounter-10">
          <td class="date">09/04/2026</td><td class="type">Follow Up</td><td class="provider">Dr Other</td>
        </tr>
      </tbody></table>
    `);
    const destination = new PrognocisBrowser(page, {
      popupTimeoutMs: 25,
      selectors: {
        encounterMenu: '#encounter-menu',
        encounterRows: '#encounters tbody tr',
        encounterDateCell: '.date',
        encounterTypeCell: '.type',
        encounterProviderCell: 'td:nth-child(3)',
        encounterIdAttribute: 'data-encounter-id',
        encounterEditorReady: '#editor'
      }
    }, { timezone: 'America/Chicago' });
    assert.equal(
      await destination.openExactEncounter(artifact().encounter),
      'ehr-encounter-9'
    );
  } finally {
    await browser.close();
  }
});

test('Playwright extracts a stable encounter ID from a legacy onclick attribute', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="encounter-menu">Encounters</button><div id="editor">Encounter editor</div>
      <table id="encounters"><tbody>
        <tr onclick="javascript:sendCode('ehr-encounter-9','09-04-2026','Follow Up')">
          <td class="date">09/04/2026</td><td class="type">Follow Up</td><td class="provider">Dr Example</td><td></td><td class="status">Open</td>
        </tr>
      </tbody></table>
    `);
    const destination = new PrognocisBrowser(page, {
      popupTimeoutMs: 25,
      encounterIdPattern: "sendCode\\('([^']+)'",
      selectors: {
        encounterMenu: '#encounter-menu', encounterRows: '#encounters tbody tr',
        encounterDateCell: '.date', encounterTypeCell: '.type', encounterProviderCell: '.provider',
        encounterIdAttribute: 'onclick', encounterStatusCell: '.status', encounterEditorReady: '#editor'
      }
    }, { timezone: 'America/Chicago' });
    assert.equal(await destination.openExactEncounter(artifact().encounter), 'ehr-encounter-9');
    assert.equal(destination.currentEncounterStatus, 'Open');
  } finally {
    await browser.close();
  }
});

test('Playwright selects the one exact Wellness exam complaint and verifies its active ID', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page);
    const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
    assert.equal(await destination.selectHpiComplaint('Any appointment type'), '958');
    assert.equal(await page.locator('#msCurrentComplaintId').inputValue(), '958');
    assert.deepEqual(await page.evaluate(() => window.order), ['hpi', 'lookup', 'search', 'select', 'confirm']);
  } finally {
    await browser.close();
  }
});

test('Playwright fails closed when confirmation does not activate Wellness exam', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page, { activate: false });
    const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
    await assert.rejects(
      destination.selectHpiComplaint('Any appointment type'),
      { code: 'HPI_COMPLAINT_NOT_ACTIVE' }
    );
  } finally {
    await browser.close();
  }
});

for (const alreadyChecked of [false, true]) {
  test(`Wellness exam selection is checked, not toggled, when already active (checked=${alreadyChecked})`, async () => {
    const browser = await launchFixtureBrowser();
    try {
      const page = await browser.newPage();
      await installComplaintFixture(page, { alreadyActive: true, alreadyChecked });
      const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
      assert.equal(await destination.selectHpiComplaint('Follow Up'), '958');
      assert.equal(await page.locator('#results input[type="checkbox"]').isChecked(), true);
      assert.equal(destination.selectedHpiComplaintId, '958');
      const order = await page.evaluate(() => window.order);
      assert.deepEqual(order, alreadyChecked
        ? ['hpi', 'lookup', 'search', 'confirm']
        : ['hpi', 'lookup', 'search', 'select', 'confirm']);
    } finally {
      await browser.close();
    }
  });
}

for (const options of [{ ambiguous: true }, { noMatch: true }]) {
  test(`complaint selection rejects ambiguous or nonexact Wellness exam results: ${JSON.stringify(options)}`, async () => {
    const browser = await launchFixtureBrowser();
    try {
      const page = await browser.newPage();
      await installComplaintFixture(page, options);
      const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
      await assert.rejects(destination.selectHpiComplaint('Follow Up'));
      assert.equal(destination.selectedHpiComplaintId, null);
      assert.equal((await page.evaluate(() => window.order)).includes('confirm'), false);
    } finally {
      await browser.close();
    }
  });
}

test('HPI entry is refused unless the exact selected complaint remains active', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    await installComplaintFixture(page);
    const destination = new PrognocisBrowser(page, complaintConfig(), { timezone: 'America/Chicago' });
    await assert.rejects(destination.assertSelectedHpiComplaint(), { code: 'HPI_COMPLAINT_NOT_ACTIVE' });
    await destination.selectHpiComplaint('Follow Up');
    await destination.assertSelectedHpiComplaint();
    await page.locator('#msCurrentComplaintId').evaluate(element => { element.value = '150'; });
    await assert.rejects(destination.assertSelectedHpiComplaint(), { code: 'HPI_COMPLAINT_NOT_ACTIVE' });
  } finally {
    await browser.close();
  }
});

test('Wellness exam popup selection unlocks HPI, saves to that complaint, and verifies on fresh reopen', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    const value = artifact();
    let savedHpi = '';
    const saves = [];
    await page.context().route('https://ehr.example.test/**', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        assert.equal(body.complaintId, '958');
        assert.equal(body.hpi, value.sections.hpi);
        savedHpi = body.hpi;
        saves.push('hpi');
        return route.fulfill({ json: { saved: true } });
      }
      if (route.request().url().includes('complaints')) {
        return route.fulfill({ contentType: 'text/html', body: `
          <input id="CMP_NAME">
          <table><tbody id="results"></tbody></table>
          <button id="ok">OK</button>
          <script>
            window.sendCODE = () => {};
            CMP_NAME.addEventListener('keyup', () => {
              results.innerHTML = ${JSON.stringify(`<tr onclick="sendCODE('cbs0','958','WELLNESS EXAM')"><td>Wellness exam</td><td><input type="checkbox"></td></tr>`)};
            });
            ok.addEventListener('click', () => {
              if (results.querySelector('input')?.checked) {
                const parent = window.opener.document;
                parent.querySelector('#msCurrentComplaintId').value = '958';
                parent.querySelector('#msPth_curcmp_notes').readOnly = false;
                parent.querySelector('#msPth_curcmp_notes').value = window.opener.savedHpi;
              }
              window.close();
            });
          </script>
        ` });
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <button id="menu_HP">HPI</button>
        <button id="searchCompl" onclick="window.open('/complaints', 'complaints')">Select complaint</button>
        <input id="msCurrentComplaintId" type="hidden" value="150">
        <textarea id="msPth_curcmp_notes" readonly></textarea>
        <button id="ok" onclick="saveHpi()">Save HPI</button>
        <script>
          window.savedHpi = ${JSON.stringify(savedHpi)};
          async function saveHpi() {
            await fetch('/hpi-save', { method: 'POST', headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({complaintId:msCurrentComplaintId.value,hpi:msPth_curcmp_notes.value}) });
          }
        </script>
      ` });
    });
    await page.goto('https://ehr.example.test/encounter');
    const config = complaintConfig();
    config.popupTimeoutMs = 2_000;
    config.sectionLoadTimeoutMs = 2_000;
    config.sectionSaveUrlPattern = '/hpi-save$';
    config.selectors.hpiField = '#msPth_curcmp_notes';
    config.selectors.hpiSaveButton = '#ok';
    const destination = new PrognocisBrowser(page, config, { timezone: 'America/Chicago' });
    assert.equal(await page.locator('#msPth_curcmp_notes').isEditable(), false);
    await destination.selectHpiComplaint('Follow Up');
    await destination.writeMissingSections(value, { sections: {
      hpi: { matches: false }, ros: { matches: true }, physicalExamination: { matches: true }
    } });
    assert.equal(savedHpi, value.sections.hpi);
    assert.deepEqual(saves, ['hpi']);
    await page.goto('https://ehr.example.test/encounter');
    await destination.selectHpiComplaint('Follow Up');
    assert.equal(await page.locator('#msPth_curcmp_notes').inputValue(), value.sections.hpi);
    await destination.assertSelectedHpiComplaint();
    assert.deepEqual(saves, ['hpi']);
  } finally {
    await browser.close();
  }
});

test('write mode selects and verifies the complaint before inspecting or writing the HPI note', async () => {
  const browser = await launchFixtureBrowser();
  try {
    const page = await browser.newPage();
    const events = [];
    const value = artifact();
    const destination = new PrognocisBrowser(page, {
      url: 'about:blank',
      selectors: {}
    }, { timezone: 'America/Chicago' });
    destination.open = async () => events.push('open');
    destination.selectPatient = async () => events.push('patient');
    destination.openExactEncounter = async () => {
      events.push('encounter');
      return value.encounter.prognocisEncounterId;
    };
    destination.assertEncounterIsEditable = async () => events.push('editable');
    destination.selectHpiComplaint = async () => events.push('complaint');
    let inspection = 0;
    destination.inspectDraft = async () => {
      inspection += 1;
      events.push('inspect');
      const exact = inspection > 1;
      return {
        sections: {
          hpi: { empty: !exact, matches: exact },
          ros: { empty: !exact, matches: exact },
          physicalExamination: { empty: !exact, matches: exact }
        },
        exact
      };
    };
    destination.assertNoDifferentClinicalText = () => events.push('conflict-check');
    destination.writeMissingSections = async () => events.push('write');
    destination.saveDraftAndVerifyStatus = async () => events.push('save');
    destination.reopenExactEncounter = async () => events.push('reopen');
    destination.verifyDraftStatus = async () => {
      events.push('verify-status');
      return true;
    };
    await destination.process(value, { writeEnabled: true });
    assert.deepEqual(events, [
      'open', 'patient', 'encounter', 'editable', 'complaint',
      'inspect', 'conflict-check', 'write', 'save', 'reopen',
      'complaint', 'inspect', 'verify-status'
    ]);
  } finally {
    await browser.close();
  }
});
