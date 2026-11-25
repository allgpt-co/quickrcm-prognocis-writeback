import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';

async function launch() {
  return chromium.launch({ headless: true,
    executablePath: await resolveChromiumExecutable({ projectRoot: process.cwd() }) });
}

test('history waits past popup budget for delayed about:blank navigation and rows', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.context().route('https://ehr.test/**', route => route.fulfill({
      contentType: 'text/html', body: '<table id="rows"><tr><td>Encounter</td></tr></table>'
    }));
    await page.setContent(`<button id="menu" onclick="const p=window.open('about:blank');setTimeout(()=>p.location='https://ehr.test/history',400)">History</button>`);
    const writer = new PrognocisBrowser(page, {
      popupTimeoutMs: 50, encounterHistoryUrlPattern: '/history',
      selectors: { encounterMenu: '#menu', encounterRows: '#rows tr' }
    }, {});
    const history = await writer.openEncounterHistory();
    assert.equal(history.url(), 'https://ehr.test/history');
    assert.equal(await history.locator('#rows tr').count(), 1);
  } finally { await browser.close(); }
});

for (const wrongEncounter of [false, true]) test(`Notes reacquires replaced frame and checks encounter identity; wrong=${wrongEncounter}`, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route('https://ehr.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/slow.js') {
        await new Promise(resolve => setTimeout(resolve, 800));
        return route.fulfill({ contentType: 'application/javascript', body: '' });
      }
      if (url.pathname === '/Assessment.action2') {
        const stable = url.searchParams.has('stable');
        return route.fulfill({ contentType: 'text/html', body: stable
          ? `<input name="msEnc_id" value="${wrongEncounter ? 'other' : '123'}"><button id="notes" onclick="document.querySelector('textarea').hidden=false">Notes</button><textarea id="field" hidden>Verified content</textarea>`
          : '<script src="/slow.js"></script>' });
      }
      await route.fulfill({ contentType: 'text/html', body: `<button id="menu" onclick="openNotes()">Assessment</button><iframe></iframe>
        <script>
        let clicks=0;
        function openNotes(){
          clicks++; document.querySelector('iframe').src='/Assessment.action2';
          setTimeout(()=>{
            document.querySelector('iframe').remove();
            const f=document.createElement('iframe');f.src='/Assessment.action2?stable=1';document.body.append(f);
          },150);
        }
        </script>` });
    });
    await page.goto('https://ehr.test/encounter');
    const writer = new PrognocisBrowser(page, {
      sectionLoadTimeoutMs: 1800, sectionUrlPatterns: { assessment: '/Assessment.action2' },
      selectors: { assessmentMenu: '#menu', assessmentNotesTab: '#notes', assessmentField: '#field' }
    }, {});
    writer.currentEncounterId = '123';
    if (wrongEncounter) await assert.rejects(writer.sectionField('assessment'), { code: 'ASSESSMENT_PLAN_LOAD_TIMEOUT' });
    else assert.equal(await (await writer.sectionField('assessment')).inputValue(), 'Verified content');
    assert.equal(await page.evaluate(() => clicks), 1, 'must not repeat menu click while recovering');
  } finally { await browser.close(); }
});

test('uncoded browser failures expose a safe workflow stage without changing coded failures', async () => {
  const writer = new PrognocisBrowser({ on() {} }, { selectors: {} }, {});
  writer.processRecord = async () => {
    writer.failureStage = 'READBACK_INSPECTION';
    throw new Error('sensitive browser detail');
  };
  await assert.rejects(writer.process({}, {}), { code: 'EHR_READBACK_INSPECTION_FAILED' });
  writer.processRecord = async () => { throw Object.assign(new Error('login'), { code: 'AUTH_REQUIRED' }); };
  await assert.rejects(writer.process({}, {}), { code: 'AUTH_REQUIRED' });
});

test('overlay dismissal reacquires a frame replaced during a click', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.route('https://ehr.test/**', route => route.fulfill({
      contentType: 'text/html',
      body: route.request().url().endsWith('/moving')
        ? '<style>@keyframes move{from{margin-left:0}to{margin-left:100px}}button{animation:move .1s infinite alternate}</style><button id="dismiss">Dismiss</button>'
        : '<button id="dismiss" onclick="this.remove()">Dismiss</button>'
    }));
    await page.setContent('<iframe src="https://ehr.test/moving"></iframe>');
    await page.frames()[1].locator('#dismiss').waitFor();
    await page.evaluate(() => setTimeout(() => {
      document.querySelector('iframe').remove();
      const frame = document.createElement('iframe');
      frame.src = 'https://ehr.test/stable';
      document.body.append(frame);
    }, 150));
    const writer = new PrognocisBrowser(page, {
      transientOverlayWaitMs: 3000, selectors: { transientOverlayDismiss: '#dismiss' }
    }, {});
    await writer.dismissTransientOverlay({ waitForPossible: true });
    assert.equal(page.frames()[1].url(), 'https://ehr.test/stable');
    assert.equal(await page.frames()[1].locator('#dismiss').count(), 0);
  } finally { await browser.close(); }
});
