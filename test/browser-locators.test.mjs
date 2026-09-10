import test from 'node:test';
import assert from 'node:assert/strict';
import * as locators from '../src/browser/locators.mjs';

const { clickInFrames } = locators;

test('state-changing frame click is attempted once after an ambiguous dispatch error', async () => {
  let clicks = 0;
  const locator = {
    async count() { return 1; },
    nth() { return this; },
    async isVisible() { return true; },
    async click() {
      clicks += 1;
      if (clicks === 1) throw new Error('Execution context was destroyed after click dispatch');
    }
  };
  const mainFrame = {};
  const page = {
    frames() { return [mainFrame]; },
    mainFrame() { return mainFrame; },
    locator() { return locator; },
    async waitForTimeout() {}
  };
  await assert.rejects(
    () => clickInFrames(page, '#save', 'clinical save', {
      retryOnTransient: false,
      timeout: 500
    }),
    /context was destroyed/i
  );
  assert.equal(clicks, 1);
});

test('credential field failures never expose the supplied value', async () => {
  assert.equal(typeof locators.fillCredentialField, 'function');
  const canary = 'credential-canary-value';
  const locator = {
    async click() {},
    async fill(value) { throw new Error(`Playwright fill failed for ${value}`); },
    async dispatchEvent() {}
  };
  await assert.rejects(
    () => locators.fillCredentialField(locator, canary, 'QuickRCM'),
    (error) => error?.code === 'AUTH_REQUIRED'
      && !String(error.message).includes(canary)
      && /credential entry failed/i.test(error.message)
  );
});
