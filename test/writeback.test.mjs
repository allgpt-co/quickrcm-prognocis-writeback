import test from 'node:test';
import assert from 'node:assert/strict';
import { runWriteback } from '../src/workflow/writeback.mjs';
import { artifact } from '../test-support/artifact.mjs';

const artifacts = [artifact({ jobId: 'job-1' }), artifact({ jobId: 'job-2' })];
const audit = { info: async () => {}, error: async () => {} };

test('probe opens exact encounters but never acknowledges QuickRCM', async () => {
  const acknowledgements = [];
  const result = await runWriteback({ automation: { writeEnabled: false, maxRecordsPerRun: 10 } }, {
    client: {
      getAttestedQueue: async () => artifacts,
      acknowledgeVerifiedDraft: async (...args) => acknowledgements.push(args)
    },
    destination: {
      process: async (value, options) => {
        assert.equal(options.writeEnabled, false);
        return { status: 'PROBED', ehrEncounterId: value.encounter.prognocisEncounterId };
      }
    },
    audit
  });
  assert.equal(result.probed, 2);
  assert.equal(result.acknowledged, 0);
  assert.equal(acknowledgements.length, 0);
});

test('write mode acknowledges only drafts that passed reopened read-back', async () => {
  const acknowledgements = [];
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 10 } }, {
    client: {
      getAttestedQueue: async () => artifacts,
      acknowledgeVerifiedDraft: async (value, encounterId) => acknowledgements.push([value.jobId, encounterId])
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
    audit
  });
  assert.deepEqual(acknowledgements, [['job-1', 'ehr-encounter-9']]);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.failed, 1);
});
