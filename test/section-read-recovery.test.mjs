import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';
import { readField } from '../src/browser/locators.mjs';

test('field type and contents are read atomically in one evaluation', async () => {
  for (const [tagName, expected, attrs] of [
    ['TEXTAREA', 'Narrative', { value: 'Narrative' }],
    ['INPUT', 'Input text', { value: 'Input text' }],
    ['SELECT', 'Selected', { value: 'Selected' }],
    ['DIV', 'Editable text', { innerText: 'Editable text', contenteditable: 'true' }],
    ['SPAN', 'Plain text', { textContent: 'Plain text' }]
  ]) {
    let evaluations = 0;
    const locator = {
      async evaluate(fn) {
        evaluations += 1;
        return fn({ tagName, ...attrs, getAttribute: name => attrs[name] ?? null });
      }
    };
    assert.equal(await readField(locator), expected);
    assert.equal(evaluations, 1);
  }
});

test('note inspection reacquires a replaced iframe without re-clicking menus or losing conflicting text', async () => {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  assert.ok(executablePath);
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe name="old" srcdoc="<textarea id=hpi></textarea>"></iframe>');
    const oldFrame = page.frame({ name: 'old' });
    await oldFrame.locator('#hpi').waitFor();
    const stale = oldFrame.locator('#hpi');
    const destination = new PrognocisBrowser(page, {
      selectors: { hpiField: '#hpi' }, sectionLoadTimeoutMs: 2000
    }, { timezone: 'America/Chicago' });
    let menuOpens = 0;
    destination.sectionField = async () => {
      menuOpens += 1;
      await page.evaluate(() => {
        document.querySelector('iframe').remove();
        const fresh = document.createElement('iframe');
        fresh.name = 'fresh';
        fresh.srcdoc = '<textarea id=hpi>Existing different narrative.</textarea>';
        document.body.append(fresh);
      });
      await page.frameLocator('iframe').locator('#hpi').waitFor();
      return stale;
    };
    const actual = await destination.readSection('hpi', 'Follow Up');
    assert.equal(actual, 'Existing different narrative.');
    assert.equal(menuOpens, 1);
    assert.throws(() => destination.assertNoDifferentClinicalText({
      sections: { hpi: { empty: false, matches: false } }
    }), { code: 'CLINICAL_TEXT_CONFLICT' });
  } finally {
    await browser.close();
  }
});

test('context-destroyed reads and a second DOM reload recover with fresh selectors, not another menu click', async () => {
  let menuOpens = 0;
  let readyChecks = 0;
  const fresh = {
    first() { return this; },
    async isVisible() { return true; },
    async evaluate(fn) {
      return fn({ tagName: 'TEXTAREA', value: 'Recovered narrative.' });
    }
  };
  const mainFrame = {};
  const page = {
    on() {}, isClosed: () => false,
    frames: () => [mainFrame], mainFrame: () => mainFrame,
    locator: () => fresh,
    async waitForTimeout() {},
    async waitForLoadState() {
      readyChecks += 1;
      if (readyChecks === 1) throw new Error('Execution context was destroyed during DOM load');
    }
  };
  const destination = new PrognocisBrowser(page, {
    selectors: { hpiField: '#hpi' }, sectionLoadTimeoutMs: 1000
  }, {});
  destination.sectionField = async () => {
    menuOpens += 1;
    return { async evaluate() { throw new Error('Execution context was destroyed'); } };
  };
  assert.equal(await destination.readSection('hpi', null), 'Recovered narrative.');
  assert.equal(menuOpens, 1);
  assert.equal(readyChecks, 2);
});

test('note read recovery is bounded and never retries closed pages or unrelated errors', async () => {
  for (const [message, closed, expected] of [
    ['Execution context was destroyed', true, /Execution context/],
    ['Permission denied', false, /Permission denied/],
    ['Execution context was destroyed', false, { code: 'CLINICAL_SECTION_READ_UNSTABLE' }]
  ]) {
    let reads = 0;
    let menuOpens = 0;
    const page = {
      on() {},
      isClosed: () => closed,
      async waitForTimeout(ms) { await new Promise(resolve => setTimeout(resolve, ms + 2)); }
    };
    const destination = new PrognocisBrowser(page, {
      selectors: {}, sectionLoadTimeoutMs: 10
    }, {});
    destination.sectionField = async () => {
      menuOpens += 1;
      return { async evaluate() { reads += 1; throw new Error(message); } };
    };
    await assert.rejects(() => destination.readSection('hpi', null), expected);
    assert.equal(menuOpens, 1);
    assert.equal(reads, 1);
  }
});
