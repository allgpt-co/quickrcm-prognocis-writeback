import test from 'node:test';
import assert from 'node:assert/strict';
import * as prognocis from '../src/integrations/prognocis-browser.mjs';

test('clinical save observes response rejection when its one-shot click fails', async () => {
  assert.equal(typeof prognocis.waitForConfiguredSave, 'function');
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const page = {
      waitForResponse() {
        return new Promise((_, reject) => setImmediate(() => reject(new Error('save response failed'))));
      }
    };
    await assert.rejects(
      () => prognocis.waitForConfiguredSave(page, {
        urlPattern: 'save',
        successSelector: '',
        timeoutMs: 100,
        label: 'clinical save'
      }, async () => {
        throw new Error('clinical click failed after dispatch');
      }),
      /clinical click failed after dispatch/
    );
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
