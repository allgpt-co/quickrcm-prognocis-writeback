import test from 'node:test';
import assert from 'node:assert/strict';
import { runWriteback } from '../src/workflow/writeback.mjs';
import { artifact } from '../test-support/artifact.mjs';

const artifacts = [artifact({ jobId: 'job-1' }), artifact({ jobId: 'job-2' })];
const audit = { info: async () => {}, error: async () => {} };

test('probe rechecks the API response source and never writes the local verified ledger', async () => {
  const marked = [];
  const revalidated = [];
  const result = await runWriteback({ automation: { writeEnabled: false, maxRecordsPerRun: 10 } }, {
    source: {
      listAttestedArtifacts: async () => artifacts,
      revalidate: async (value) => revalidated.push(value.jobId)
    },
    destination: {
      process: async (value, options) => {
        assert.equal(options.writeEnabled, false);
        return { status: 'PROBED', ehrEncounterId: value.encounter.prognocisEncounterId };
      }
    },
    ledger: { has: () => false, markVerified: async (...args) => marked.push(args) },
    audit
  });
  assert.equal(result.probed, 2);
  assert.equal(result.verified, 0);
  assert.deepEqual(revalidated, ['job-1', 'job-2']);
  assert.equal(marked.length, 0);
});

test('write mode records only drafts that passed EHR read-back and a second source check', async () => {
  const marked = [];
  const revalidated = [];
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 10 } }, {
    source: {
      listAttestedArtifacts: async () => artifacts,
      revalidate: async (value) => revalidated.push(value.jobId)
    },
    destination: {
      process: async (value) => {
        if (value.jobId === 'job-2') {
          const error = new Error('read-back failed');
          error.code = 'DRAFT_READBACK_FAILED';
          throw error;
        }
        return { status: 'DRAFT_VERIFIED', ehrEncounterId: 'ehr-encounter-9', duplicate: false };
      }
    },
    ledger: {
      has: () => false,
      markVerified: async (proof) => marked.push(proof)
    },
    audit
  });
  assert.equal(marked.length, 1);
  assert.equal(marked[0].artifactHash, artifacts[0].artifactHash);
  assert.deepEqual(revalidated, ['job-1', 'job-1', 'job-2']);
  assert.equal(result.verified, 1);
  assert.equal(result.failed, 1);
});

test('verified ledger hash skips an already completed API artifact', async () => {
  let destinationCalls = 0;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 10 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => { throw new Error('should not revalidate a verified hash'); }
    },
    destination: { process: async () => { destinationCalls += 1; } },
    ledger: { has: () => true, markVerified: async () => {} },
    audit
  });
  assert.equal(result.skipped, 1);
  assert.equal(destinationCalls, 0);
});
