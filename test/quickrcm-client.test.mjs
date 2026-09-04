import test from 'node:test';
import assert from 'node:assert/strict';
import { QuickRcmClient } from '../src/integrations/quickrcm-client.mjs';
import { artifact } from '../test-support/artifact.mjs';

function config() {
  return {
    baseUrl: 'https://quickrcm.example.test',
    queuePath: '/api/v2/scribe/prognocis-writeback',
    ackPath: '/api/v2/scribe/prognocis-writeback/{jobId}/ack',
    requestTimeoutMs: 5_000
  };
}

test('requests only ATTESTED records and validates every queue item', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      version: 2,
      destination: 'prognocis',
      items: [artifact()]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new QuickRcmClient(config(), 'service-key', fetchImpl);
  const items = await client.getAttestedQueue(10);
  assert.equal(items.length, 1);
  assert.match(calls[0].url, /status=ATTESTED/);
  assert.match(calls[0].url, /limit=10/);
  assert.deepEqual(Object.keys(calls[0].options.headers).sort(), ['Accept', 'Authorization']);
});

test('acknowledgement contains only exact non-PHI verification proof', async () => {
  let requestBody;
  const fetchImpl = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'DRAFT_VERIFIED' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const client = new QuickRcmClient(config(), 'service-key', fetchImpl);
  const value = artifact();
  await client.acknowledgeVerifiedDraft(value, 'ehr-encounter-9');
  assert.deepEqual(requestBody, {
    destination: 'prognocis',
    status: 'DRAFT_VERIFIED',
    artifactHash: value.artifactHash,
    ehrEncounterId: 'ehr-encounter-9'
  });
});
