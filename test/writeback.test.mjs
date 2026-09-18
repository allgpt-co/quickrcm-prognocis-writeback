import test from 'node:test';
import assert from 'node:assert/strict';
import { runWriteback } from '../src/workflow/writeback.mjs';
import { artifact } from '../test-support/artifact.mjs';

const artifacts = [artifact({ jobId: 'job-1' }), artifact({ jobId: 'job-2' })];
const audit = { info: async () => {}, error: async () => {} };

test('supervised no-ack write mode verifies drafts but never updates source or acknowledgement ledger', async () => {
  for (const alreadyVerified of [false, true]) {
    const events = [];
    const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
      source: {
        listAttestedArtifacts: async () => [artifacts[0]],
        revalidate: async () => events.push('revalidate'),
        markWrittenBack: async () => assert.fail('No-ack mode must never acknowledge the source')
      },
      destination: {
        process: async (_, options) => {
          assert.equal(alreadyVerified, false, 'Verified content must not be rewritten');
          assert.equal(options.writeEnabled, true);
          events.push('destination');
          return { status: 'DRAFT_VERIFIED', ehrEncounterId: 'ehr-encounter-9' };
        }
      },
      ledger: {
        has: () => alreadyVerified, isAcknowledged: () => false,
        markVerified: async () => events.push('verified'),
        markAcknowledged: async () => assert.fail('No-ack mode must not mark local acknowledgement')
      }, audit
    }, { acknowledgeSource: false });
    assert.equal(result.mode, 'draft-write-no-ack');
    assert.equal(result.acknowledged, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.verified, alreadyVerified ? 0 : 1);
    assert.equal(result.skipped, alreadyVerified ? 1 : 0);
    assert.deepEqual(events, alreadyVerified ? ['revalidate'] : ['revalidate', 'destination', 'revalidate', 'verified']);
  }
});

test('no-ack mode still refuses unverified destination output', async () => {
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]], revalidate: async () => true,
      markWrittenBack: async () => assert.fail('No acknowledgement permitted')
    },
    destination: { process: async () => ({ status: 'PROBED' }) },
    ledger: {
      has: () => false, isAcknowledged: () => false,
      markVerified: async () => assert.fail('Unverified content must not get proof'),
      markAcknowledged: async () => assert.fail('No acknowledgement permitted')
    }, audit
  }, { acknowledgeSource: false });
  assert.equal(result.failed, 1);
  assert.equal(result.verified, 0);
  assert.equal(result.acknowledged, 0);
});

test('probe rechecks the API response source and never acknowledges or writes the ledger', async () => {
  const marked = [];
  const revalidated = [];
  const result = await runWriteback({ automation: { writeEnabled: false, maxRecordsPerRun: 10 } }, {
    source: {
      listAttestedArtifacts: async () => artifacts,
      revalidate: async (value) => revalidated.push(value.jobId),
      markWrittenBack: async () => assert.fail('Probe mode must not acknowledge source rows')
    },
    destination: {
      process: async (value, options) => {
        assert.equal(options.writeEnabled, false);
        return { status: 'PROBED', ehrEncounterId: value.encounter.prognocisEncounterId };
      }
    },
    ledger: {
      has: () => false,
      isAcknowledged: () => false,
      markVerified: async (...args) => marked.push(args),
      markAcknowledged: async (...args) => marked.push(args)
    },
    audit
  });
  assert.equal(result.probed, 2);
  assert.equal(result.verified, 0);
  assert.equal(result.acknowledged, 0);
  assert.deepEqual(revalidated, ['job-1', 'job-2']);
  assert.equal(marked.length, 0);
});

test('write mode persists verified proof before acknowledging each exact source row', async () => {
  const events = [];
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 10 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => events.push('revalidate'),
      markWrittenBack: async () => {
        events.push('mark-written-back');
        return { clinicalExportId: 'export-1' };
      }
    },
    destination: {
      process: async () => {
        events.push('destination');
        return { status: 'DRAFT_VERIFIED', ehrEncounterId: 'ehr-encounter-9', duplicate: false };
      }
    },
    ledger: {
      has: () => false,
      isAcknowledged: () => false,
      markVerified: async () => events.push('mark-verified'),
      markAcknowledged: async () => events.push('mark-acknowledged')
    },
    audit
  });
  assert.deepEqual(events, [
    'revalidate', 'destination', 'revalidate', 'mark-verified',
    'mark-written-back', 'mark-acknowledged'
  ]);
  assert.equal(result.verified, 1);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.failed, 0);
});

test('a verified-but-unacknowledged artifact retries acknowledgement without rewriting PrognoCIS', async () => {
  let destinationCalls = 0;
  let acknowledgements = 0;
  let acknowledgedProofs = 0;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => true,
      markWrittenBack: async () => {
        acknowledgements += 1;
        return {
          clinicalExportId: '44444444-4444-4444-8444-444444444444',
          writtenBackAt: '2026-09-17T20:00:00.000Z'
        };
      }
    },
    destination: { process: async () => { destinationCalls += 1; } },
    ledger: {
      has: () => true,
      isAcknowledged: () => false,
      markVerified: async () => assert.fail('Draft is already verified'),
      markAcknowledged: async () => { acknowledgedProofs += 1; }
    },
    audit
  });
  assert.equal(destinationCalls, 0);
  assert.equal(acknowledgements, 1);
  assert.equal(acknowledgedProofs, 1);
  assert.equal(result.recovered, 1);
  assert.equal(result.acknowledged, 1);
  assert.equal(result.skipped, 0);
});

test('an already acknowledged local artifact is skipped without another external call', async () => {
  let externalCalls = 0;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => { externalCalls += 1; },
      markWrittenBack: async () => { externalCalls += 1; }
    },
    destination: { process: async () => { externalCalls += 1; } },
    ledger: {
      has: () => true,
      isAcknowledged: () => true,
      markVerified: async () => {},
      markAcknowledged: async () => {}
    },
    audit
  });
  assert.equal(result.skipped, 1);
  assert.equal(externalCalls, 0);
});

test('acknowledgement failure retains draft proof and never records acknowledgement', async () => {
  let verifiedProofs = 0;
  let acknowledgedProofs = 0;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => true,
      markWrittenBack: async () => {
        const error = new Error('ambiguous acknowledgement');
        error.code = 'CARE1960_ACKNOWLEDGEMENT_INVALID';
        throw error;
      }
    },
    destination: {
      process: async () => ({ status: 'DRAFT_VERIFIED', ehrEncounterId: 'ehr-encounter-9', duplicate: false })
    },
    ledger: {
      has: () => false,
      isAcknowledged: () => false,
      markVerified: async () => { verifiedProofs += 1; },
      markAcknowledged: async () => { acknowledgedProofs += 1; }
    },
    audit
  });
  assert.equal(verifiedProofs, 1);
  assert.equal(acknowledgedProofs, 0);
  assert.equal(result.verified, 1);
  assert.equal(result.acknowledged, 0);
  assert.equal(result.failed, 1);
});

test('EHR read-back failure never acknowledges the source row', async () => {
  let acknowledgements = 0;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source: {
      listAttestedArtifacts: async () => [artifacts[0]],
      revalidate: async () => true,
      markWrittenBack: async () => { acknowledgements += 1; }
    },
    destination: {
      process: async () => {
        const error = new Error('read-back failed');
        error.code = 'DRAFT_READBACK_FAILED';
        throw error;
      }
    },
    ledger: {
      has: () => false,
      isAcknowledged: () => false,
      markVerified: async () => assert.fail('Unverified draft must not enter ledger'),
      markAcknowledged: async () => assert.fail('Unverified draft must not be acknowledged')
    },
    audit
  });
  assert.equal(acknowledgements, 0);
  assert.equal(result.verified, 0);
  assert.equal(result.acknowledged, 0);
  assert.equal(result.failed, 1);
});
