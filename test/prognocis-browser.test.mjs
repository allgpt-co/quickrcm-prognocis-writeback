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
