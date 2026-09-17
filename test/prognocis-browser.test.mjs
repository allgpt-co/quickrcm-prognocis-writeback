import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser, stablePatientId } from '../src/integrations/prognocis-browser.mjs';
import { artifact } from '../test-support/artifact.mjs';

async function launchFixtureBrowser() {
  const executablePath = await resolveChromiumExecutable({
    projectRoot: '/',
    executablePath: '/home/hermes/.hermes/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome'
  });
  assert.ok(executablePath, 'The live Cron Chromium executable is required for browser fixtures');
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

async function installComplaintFixture(page, { activate = true } = {}) {
  await page.setContent(`
    <button id="searchCompl">Search complaint</button>
    <input id="msCurrentComplaintId" type="hidden" value="150">
    <div id="panel" hidden>
      <input id="CMP_NAME">
      <table><tbody id="results"></tbody></table>
      <button id="ok">OK</button>
    </div>
    <script>
      window.order = [];
      window.sendCODE = () => {};
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
        name.textContent = 'Wellness exam';
        const choice = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.addEventListener('click', () => order.push('select'));
        choice.append(checkbox);
        row.append(name, choice);
        results.replaceChildren(row);
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

test('Playwright opens only the exact date, type, provider, and encounter-ID row', async () => {
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
        encounterProviderCell: '.provider',
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
    assert.deepEqual(await page.evaluate(() => window.order), ['lookup', 'search', 'select', 'confirm']);
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
