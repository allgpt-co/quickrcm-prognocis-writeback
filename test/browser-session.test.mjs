import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as session from '../src/browser/session.mjs';

test('CDP cleanup closes only stale PrognoCIS login targets', async () => {
  assert.equal(typeof session.closeStaleLoginTargets, 'function');
  const closed = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/json/list') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify([
        { id: 'login-page', type: 'page', url: 'https://ehr.example.test/scrUserLogin.jsp?clinic=test' },
        { id: 'login-action', type: 'page', url: 'https://ehr.example.test/scrUserLogin.action2' },
        { id: 'patient-frame', type: 'page', url: 'https://ehr.example.test/scrPatientFrame.jsp' },
        { id: 'other-origin', type: 'page', url: 'https://other.example.test/scrUserLogin.jsp' }
      ].filter((target) => !closed.includes(target.id))));
      return;
    }
    const match = request.url.match(/^\/json\/close\/(.+)$/);
    if (match) {
      closed.push(decodeURIComponent(match[1]));
      response.end('Target is closing');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    const result = await session.closeStaleLoginTargets(
      `http://127.0.0.1:${address.port}`,
      'https://ehr.example.test/scrUserLogin.jsp?clinic=test'
    );
    assert.equal(result, 2);
    assert.deepEqual(closed.sort(), ['login-action', 'login-page']);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
