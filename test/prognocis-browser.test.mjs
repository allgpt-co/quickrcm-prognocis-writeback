import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';
import { artifact } from '../test-support/artifact.mjs';

test('Playwright opens only the exact date, type, provider, and encounter-ID row', async () => {
  const executablePath = await resolveChromiumExecutable({
    projectRoot: process.cwd(),
    executablePath: ''
  });
  assert.ok(executablePath, 'A Chromium executable is required for the browser fixture');
  const browser = await chromium.launch({ headless: true, executablePath });
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
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  const browser = await chromium.launch({ headless: true, executablePath });
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

test('Playwright disambiguates duplicate ICD-10 results by source-description overlap', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="diagnosis-menu" onclick="window.diagnosisMenuClicks=(window.diagnosisMenuClicks||0)+1">Assessment</button><button id="add-diagnosis">Add</button>
      <input id="search"><button id="search-button">Search</button>
      <table><tbody>
        <tr class="result"><td><input id="preferred" type="checkbox"></td><td>Acute upper respiratory infection of multiple sites</td><td></td><td>J06.9</td></tr>
        <tr class="result"><td><input id="other" type="checkbox"></td><td>URI (upper respiratory infection)</td><td></td><td>J06.9</td></tr>
      </tbody></table><button id="confirm">OK</button>
    `);
    const destination = new PrognocisBrowser(page, {
      popupTimeoutMs: 25,
      selectors: {
        diagnosisMenu: '#diagnosis-menu', diagnosisAddButton: '#add-diagnosis',
        diagnosisSearchInput: '#search', diagnosisSearchButton: '#search-button',
        diagnosisResultRows: '.result', diagnosisResultDescriptionCell: 'td:nth-child(2)',
        diagnosisResultCodeCell: 'td:nth-child(4)', diagnosisSelectButton: 'input[type="checkbox"]',
        diagnosisConfirmButton: '#confirm'
      }
    }, { timezone: 'America/Chicago' });
    await destination.addDiagnosis({
      code: 'J06.9', description: 'Acute upper respiratory infection, unspecified'
    });
    assert.equal(await page.evaluate(() => window.diagnosisMenuClicks ?? 0), 0);
    assert.equal(await page.locator('#preferred').isChecked(), true);
    assert.equal(await page.locator('#other').isChecked(), false);
  } finally {
    await browser.close();
  }
});

test('Playwright waits for the asynchronously rendered diagnosis section before reading it', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <button id="diagnosis-menu" onclick="setTimeout(() => document.querySelector('#diagnoses').hidden=false, 50)">Assessment</button>
      <section id="diagnoses" hidden>
        <button id="add-diagnosis">Add</button>
        <div class="diagnosis-row">J06.9 Acute upper respiratory infection, unspecified</div>
      </section>
    `);
    const destination = new PrognocisBrowser(page, {
      selectors: {
        diagnosisMenu: '#diagnosis-menu',
        diagnosisAddButton: '#add-diagnosis',
        existingDiagnosisRows: '.diagnosis-row'
      }
    }, { timezone: 'America/Chicago' });
    assert.deepEqual(await destination.readDiagnoses(), [
      'J06.9 Acute upper respiratory infection, unspecified'
    ]);
  } finally {
    await browser.close();
  }
});
