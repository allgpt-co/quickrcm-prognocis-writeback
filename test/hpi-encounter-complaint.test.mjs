import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolveChromiumExecutable } from '../src/browser/session.mjs';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';

function config() {
  return {
    url: 'https://ehr.example.test/',
    hpiComplaintName: 'Wellness exam',
    hpiComplaintIdAttribute: 'onclick',
    hpiComplaintIdPattern: "sendCODE\\('(?:[^']*)','([^']+)'",
    sectionUrlPatterns: { hpi: 'TestsExecHPINew[.]action2' },
    popupTimeoutMs: 2000,
    sectionLoadTimeoutMs: 500,
    patientSearchTimeoutMs: 500,
    selectors: {
      hpiMenu: '#menu_HP',
      hpiComplaintLookupButton: '#searchCompl',
      hpiComplaintSearchInput: '#CMP_NAME',
      hpiComplaintRows: '#results tr',
      hpiComplaintNameCell: 'td:first-child',
      hpiComplaintSelectButton: 'input[type="checkbox"]',
      hpiComplaintConfirmButton: '#ok',
      hpiComplaintCloseButton: '#close',
      hpiActiveComplaintId: '#msCurrentComplaintId',
      hpiEncounterComplaintRows: 'tr:has(> td[id^="CompName"])',
      hpiEncounterComplaintNameCell: 'td[id^="CompName"]',
      hpiEncounterComplaintCheckbox: 'input[type="checkbox"][id^="ccomplaint"]',
      hpiEncounterComplaintIdField: 'input[name="maComplaintList[{index}].msCategoryId"]'
    }
  };
}

async function fixture(options = {}) {
  const executablePath = await resolveChromiumExecutable({ projectRoot: process.cwd(), executablePath: '' });
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage();
  let lookupOpens = 0;
  await page.context().route('https://ehr.example.test/**', async route => {
    const url = new URL(route.request().url());
    let body;
    if (url.pathname === '/lookup') {
      lookupOpens += 1;
      body = `<input id="CMP_NAME"><table id="results"><tr onclick="sendCODE('cb','958')">
        <td>Wellness exam</td><td><input type="checkbox"></td></tr></table>
        <button id="ok" onclick="window.opener.location.href='/TestsExecHPINew.action2?added=1';window.close()">OK</button>
        <button id="close" onclick="window.close()">Close</button><script>function sendCODE(){}</script>`;
    } else if (url.pathname.endsWith('TestsExecHPINew.action2')) {
      const active = url.searchParams.get('active') ?? (options.alreadyActive ? '958' : '1457');
      const rows = [
        { name: 'Wellness exam follow up', id: '1457', checked: true },
        { name: '✓&nbsp;WELLNESS EXAM', id: '958', checked: options.alreadyChecked ?? false }
      ];
      if (options.absent && !url.searchParams.has('added')) rows.pop();
      if (options.duplicate) rows.push({ name: 'Wellness exam', id: '999', checked: false });
      if (options.wellnessFirst || (options.reorderOnActivate && url.searchParams.has('active'))) rows.reverse();
      body = `<button id="searchCompl" onclick="window.open('/lookup','complaints')">Lookup</button>
        <input id="msCurrentComplaintId" type="hidden" value="${active}"><table><tbody>
        ${rows.map((row, i) => `<tr>
          <td><input type="button" id="delcomplaint${i}" value="Delete"></td>
          <td id="CompName${i}" onclick="${options.activationFails ? '' : `location.href='/TestsExecHPINew.action2?active=${row.id}&added=1'`}"><b>${row.name}</b></td>
          <td><input id="ccomplaint${i}" name="ccomplaint${i}" type="checkbox" ${row.checked ? 'checked' : ''}
            onclick="parent.events.push({action:'check',id:'${row.id}',checked:this.checked})"></td>
        </tr>`).join('')}</tbody></table>
        ${rows.map((row, i) => `<input type="hidden" name="maComplaintList[${i}].msCategoryId" value="${row.id}">`).join('')}
        <textarea id="msPth_curcmp_notes">Existing saved narrative.</textarea>`;
    } else {
      // This stale value in another frame must never override the real HPI value.
      body = `<input id="msCurrentComplaintId" type="hidden" value="stale-outer-id">
        <button id="menu_HP">HPI</button><iframe name="hpi" src="/TestsExecHPINew.action2"></iframe>
        <script>window.events=[]</script>`;
    }
    await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await page.goto('https://ehr.example.test/');
  await page.frameLocator('iframe').locator('#searchCompl').waitFor();
  const destination = new PrognocisBrowser(page, config(), {});
  return { browser, page, destination, lookupOpens: () => lookupOpens };
}

for (const wellnessFirst of [false, true]) {
  test(`checks the exact Wellness row, preserves its neighbor, and activates its narrative (first=${wellnessFirst})`, async () => {
    const f = await fixture({ wellnessFirst });
    try {
      assert.equal(await f.destination.selectHpiComplaint('Any'), '958');
      const target = await f.destination.findEncounterHpiComplaint('Wellness exam', '958');
      assert.equal(await target.checkbox.isChecked(), true);
      assert.equal(await target.scope.locator('#msCurrentComplaintId').inputValue(), '958');
      const other = await f.destination.findEncounterHpiComplaint('Wellness exam follow up', '1457');
      assert.equal(await other.checkbox.isChecked(), true);
      assert.equal(await target.scope.locator('#msPth_curcmp_notes').inputValue(), 'Existing saved narrative.');
      assert.deepEqual(await f.page.evaluate(() => events), [{ action: 'check', id: '958', checked: true }]);
      assert.equal(f.lookupOpens(), 0);
    } finally { await f.browser.close(); }
  });
}

test('reacquires the correct checkbox when activation reloads HPI and changes row indexes', async () => {
  const f = await fixture({ reorderOnActivate: true });
  try {
    const before = await f.destination.findEncounterHpiComplaint('Wellness exam');
    assert.equal(await before.checkbox.getAttribute('id'), 'ccomplaint1');
    await f.destination.selectHpiComplaint('Any');
    const after = await f.destination.findEncounterHpiComplaint('Wellness exam');
    assert.equal(await after.checkbox.getAttribute('id'), 'ccomplaint0');
    assert.equal(await after.checkbox.isChecked(), true);
    assert.deepEqual(await f.page.evaluate(() => events), [{ action: 'check', id: '958', checked: true }]);
  } finally { await f.browser.close(); }
});

test('an already-active checked Wellness complaint is left intact without lookup or checkbox toggling', async () => {
  const f = await fixture({ alreadyActive: true, alreadyChecked: true });
  try {
    await f.destination.selectHpiComplaint('Any');
    await f.destination.assertSelectedHpiComplaint();
    assert.deepEqual(await f.page.evaluate(() => events), []);
    assert.equal(f.lookupOpens(), 0);
    assert.equal(await f.page.frameLocator('iframe').locator('#msPth_curcmp_notes').inputValue(), 'Existing saved narrative.');
  } finally { await f.browser.close(); }
});

test('ticking Wellness without activating it still fails; no other checkbox is changed', async () => {
  const f = await fixture({ alreadyChecked: true, activationFails: true });
  try {
    await assert.rejects(f.destination.selectHpiComplaint('Any'), { code: 'HPI_COMPLAINT_NOT_ACTIVE' });
    assert.deepEqual(await f.page.evaluate(() => events), []);
  } finally { await f.browser.close(); }
});

test('duplicate exact Wellness rows stop selection before any checkbox or lookup is used', async () => {
  const f = await fixture({ duplicate: true });
  try {
    await assert.rejects(f.destination.selectHpiComplaint('Any'), /2 exact encounter HPI complaint matches/);
    assert.deepEqual(await f.page.evaluate(() => events), []);
    assert.equal(f.lookupOpens(), 0);
  } finally { await f.browser.close(); }
});

test('guard rejects an unchecked, substituted, or no-longer-active complaint before HPI entry or save', async () => {
  const f = await fixture({ alreadyActive: true });
  try {
    await f.destination.selectHpiComplaint('Any');
    const row = await f.destination.findEncounterHpiComplaint('Wellness exam');
    await row.checkbox.uncheck();
    await assert.rejects(f.destination.assertSelectedHpiComplaint(), { code: 'HPI_COMPLAINT_NOT_CHECKED' });
    await row.checkbox.check();
    const activeId = row.scope.locator('#msCurrentComplaintId');
    await activeId.evaluate(e => { e.value = '1457'; });
    await assert.rejects(f.destination.assertSelectedHpiComplaint(), { code: 'HPI_COMPLAINT_NOT_ACTIVE' });
    await activeId.evaluate(e => { e.value = '958'; });
    await row.scope.locator('input[name="maComplaintList[1].msCategoryId"]').evaluate(e => { e.value = '1457'; });
    await assert.rejects(f.destination.assertSelectedHpiComplaint(), { code: 'HPI_COMPLAINT_ID_INVALID' });
  } finally { await f.browser.close(); }
});

test('adds a missing complaint through lookup, then separately activates and checks its encounter row', async () => {
  const f = await fixture({ absent: true });
  try {
    assert.equal(await f.destination.selectHpiComplaint('Any'), '958');
    await f.destination.assertSelectedHpiComplaint();
    assert.equal(f.lookupOpens(), 1);
    assert.deepEqual(await f.page.evaluate(() => events), [{ action: 'check', id: '958', checked: true }]);
  } finally { await f.browser.close(); }
});

test('an open lookup is closed without re-adding an existing inactive complaint', async () => {
  const f = await fixture();
  try {
    const popup = f.page.context().waitForEvent('page');
    await f.page.frameLocator('iframe').locator('#searchCompl').click();
    await (await popup).waitForLoadState();
    assert.equal(await f.destination.selectHpiComplaint('Any'), '958');
    await f.destination.assertSelectedHpiComplaint();
    assert.equal(f.page.context().pages().length, 1);
    assert.equal(f.lookupOpens(), 1);
    assert.equal(await f.page.frameLocator('iframe').locator('#msPth_curcmp_notes').inputValue(), 'Existing saved narrative.');
  } finally { await f.browser.close(); }
});
