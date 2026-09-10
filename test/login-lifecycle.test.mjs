import test from 'node:test';
import assert from 'node:assert/strict';
import * as quickscribe from '../src/integrations/quickscribe-browser.mjs';

test('login submit observes navigation rejection even when the click fails first', async () => {
  assert.equal(typeof quickscribe.runWithObservedNavigation, 'function');
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const navigation = Promise.reject(new Error('navigation failed'));
    await assert.rejects(
      () => quickscribe.runWithObservedNavigation(navigation, async () => {
        throw new Error('login click failed');
      }),
      /login click failed/
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
