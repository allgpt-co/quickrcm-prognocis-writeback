import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RetryLedger } from '../src/runtime/retry-ledger.mjs';
import { VerificationLedger } from '../src/runtime/ledger.mjs';
import { runWriteback } from '../src/workflow/writeback.mjs';
import { artifact } from '../test-support/artifact.mjs';

const key = (job) => crypto.createHash('sha256').update(job.jobId).digest('hex');
const first = artifact({ jobId: 'tenant:job-1' });
const second = artifact({ jobId: 'tenant:job-2' });
const config = { automation: { writeEnabled: true, maxRecordsPerRun: 10, maxRetries: 2 }, care1960: { input: 'http' } };
const acknowledgement = {
  clinicalExportId: '44444444-4444-4444-8444-444444444444',
  writtenBackAt: '2026-09-23T12:00:00Z'
};
const clinicalFailure = () => Object.assign(new Error('Synthetic complaint failure'), { code: 'HPI_COMPLAINT_NOT_ACTIVE' });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'retry-writeback-'));
  t.after(() => fs.rm(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'retries.json');
  const events = [];
  const source = {
    listAttestedArtifacts: async () => [first],
    revalidate: async () => {},
    markRetryFailed: async (value) => { events.push(`flag:${value.jobId}`); return acknowledgement; },
    markWrittenBack: async (value) => { events.push(`ack:${value.jobId}`); return acknowledgement; }
  };
  const destination = {
    prepare: async () => events.push('prepare'),
    process: async (value) => { events.push(`write:${value.jobId}`); throw clinicalFailure(); }
  };
  const audit = { info: async () => {}, error: async () => {} };
  async function reopen() {
    const retryLedger = new RetryLedger(file);
    await retryLedger.init();
    const ledger = new VerificationLedger(path.join(directory, 'verified.jsonl'));
    await ledger.init();
    return { source, destination, retryLedger, ledger, audit };
  }
  return { directory, file, events, source, destination, reopen };
}

test('initial attempt plus exactly two retries survive restarts; exhausted job leaves the queue and later job runs', async (t) => {
  const f = await fixture(t);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const services = await f.reopen();
    const summary = await runWriteback(config, services);
    assert.equal(summary.failed, 1);
    assert.equal(summary.retryFailed, 0);
    assert.equal(services.retryLedger.get(key(first)).attempts, attempt);
    assert.equal(f.events.some((value) => value.startsWith('flag:')), false);
  }
  f.source.listAttestedArtifacts = async () => [first, second];
  f.destination.process = async (value) => {
    f.events.push(`write:${value.jobId}`);
    if (value.jobId === first.jobId) throw clinicalFailure();
    return { status: 'DRAFT_VERIFIED', ehrEncounterId: 'encounter-2' };
  };
  const services = await f.reopen();
  const summary = await runWriteback(config, services);
  assert.equal(summary.retryFailed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.verified, 1);
  assert.equal(summary.acknowledged, 1);
  assert.deepEqual(f.events.slice(-6), [
    'write:tenant:job-1', 'flag:tenant:job-1', 'ack:tenant:job-1',
    'prepare', 'write:tenant:job-2', 'ack:tenant:job-2'
  ]);
  assert.deepEqual(services.retryLedger.get(key(first)), { attempts: 3, retired: true });
  assert.equal(services.ledger.has(first.artifactHash), false, 'Retirement must not fabricate draft proof');
  assert.equal(services.ledger.isAcknowledged(first.artifactHash), false);
  const replay = await runWriteback(config, await f.reopen());
  assert.equal(replay.skipped, 2);
  assert.equal(f.events.filter((value) => value === 'write:tenant:job-1').length, 3);
  const stored = await fs.readFile(f.file, 'utf8');
  assert.doesNotMatch(stored, /patient|dob|hpi|tenant:job|Synthetic/i);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
});

test('after either retirement RPC fails, restart retries the RPCs in order without another EHR attempt', async (t) => {
  for (const failedStep of ['flag', 'ack']) {
    await t.test(failedStep, async (t) => {
      const f = await fixture(t);
      const services = await f.reopen();
      for (let count = 0; count < 3; count += 1) await services.retryLedger.beginAttempt(key(first), 3);
      const method = failedStep === 'flag' ? 'markRetryFailed' : 'markWrittenBack';
      const original = f.source[method];
      f.source[method] = async () => { f.events.push(`failed:${failedStep}`); throw new Error('RPC unavailable'); };
      assert.equal((await runWriteback(config, services)).failed, 1);
      assert.deepEqual(f.events, failedStep === 'flag' ? ['failed:flag'] : ['flag:tenant:job-1', 'failed:ack']);
      assert.equal(services.retryLedger.get(key(first)).retired, false);
      f.source[method] = original;
      const reopened = await f.reopen();
      const result = await runWriteback(config, reopened);
      assert.equal(result.retryFailed, 1);
      assert.equal(result.failed, 0);
      assert.deepEqual(f.events.slice(-2), ['flag:tenant:job-1', 'ack:tenant:job-1']);
      assert.equal(f.events.includes('prepare'), false);
      assert.equal(reopened.retryLedger.get(key(first)).attempts, 3);
    });
  }
});

test('changed note content does not reset the per-job budget', async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    f.source.listAttestedArtifacts = async () => [artifact({
      jobId: first.jobId,
      sections: { ...first.sections, hpi: `Different attested history version ${attempt}.` }
    })];
    await runWriteback(config, await f.reopen());
  }
  assert.equal(f.events.filter((value) => value.startsWith('write:')).length, 3);
  assert.equal((await f.reopen()).retryLedger.get(key(first)).retired, true);
});

test('success on the final attempt and failed acknowledgement recover without setting retry_failed', async (t) => {
  const f = await fixture(t);
  for (let attempt = 0; attempt < 2; attempt += 1) await runWriteback(config, await f.reopen());
  f.destination.process = async () => ({ status: 'DRAFT_VERIFIED', ehrEncounterId: 'encounter-1' });
  const original = f.source.markWrittenBack;
  f.source.markWrittenBack = async () => { throw new Error('Acknowledgement unavailable'); };
  const failedAck = await runWriteback(config, await f.reopen());
  assert.equal(failedAck.verified, 1);
  assert.equal(failedAck.failed, 1);
  f.source.markWrittenBack = original;
  f.destination.prepare = async () => assert.fail('Recovery must not open Chrome');
  const recovered = await runWriteback(config, await f.reopen());
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.retryFailed, 0);
  assert.equal(f.events.some((value) => value.startsWith('flag:')), false);
});

test('probe and no-ack runs neither consume retries nor retire an exhausted record', async (t) => {
  const f = await fixture(t);
  const services = await f.reopen();
  for (let count = 0; count < 3; count += 1) await services.retryLedger.beginAttempt(key(first), 3);
  f.source.markRetryFailed = f.source.markWrittenBack = async () => assert.fail('Must not update source');
  f.destination.process = async (_, { writeEnabled }) => writeEnabled
    ? { status: 'DRAFT_VERIFIED', ehrEncounterId: 'encounter-1' }
    : { status: 'PROBED' };
  const probe = await runWriteback({ ...config, automation: { ...config.automation, writeEnabled: false } }, services);
  assert.equal(probe.probed, 1);
  const noAck = await runWriteback(config, services, { acknowledgeSource: false });
  assert.equal(noAck.verified, 1);
  assert.deepEqual(services.retryLedger.get(key(first)), { attempts: 3, retired: false });
});

test('browser startup and explicit authentication failures do not exhaust clinical retries', async (t) => {
  const f = await fixture(t);
  f.destination.prepare = async () => { throw new Error('Browser unavailable'); };
  assert.equal((await runWriteback(config, await f.reopen())).failed, 1);
  assert.equal((await f.reopen()).retryLedger.get(key(first)).attempts, 0);
  f.destination.prepare = async () => {};
  f.destination.process = async () => { throw Object.assign(new Error('Sign in'), { code: 'AUTH_REQUIRED' }); };
  for (let count = 0; count < 3; count += 1) {
    await assert.rejects(runWriteback(config, await f.reopen()), { code: 'AUTH_REQUIRED' });
  }
  assert.equal((await f.reopen()).retryLedger.get(key(first)).attempts, 0);
  assert.equal(f.events.length, 0);
});

test('an interrupted final attempt stays exhausted on restart and tenant budgets stay separate', async (t) => {
  const f = await fixture(t);
  const services = await f.reopen();
  for (let count = 0; count < 3; count += 1) await services.retryLedger.beginAttempt(key(first), 3);
  assert.equal((await runWriteback(config, await f.reopen())).retryFailed, 1);
  assert.equal(f.events.some((value) => value.startsWith('write:')), false);
  const anotherTenant = artifact({ jobId: 'other-tenant:job-1' });
  assert.deepEqual((await f.reopen()).retryLedger.get(key(anotherTenant)), { attempts: 0, retired: false });
});

test('corrupted retry state fails closed rather than resetting the count', async (t) => {
  const f = await fixture(t);
  await f.reopen();
  for (const content of ['{"version":', JSON.stringify({ version: 1, jobs: { [key(first)]: { attempts: -1, retired: false } } })]) {
    await fs.writeFile(f.file, content);
    await assert.rejects(f.reopen());
  }
});

test('retirement refuses mismatched export identities', async (t) => {
  const f = await fixture(t);
  const services = await f.reopen();
  for (let count = 0; count < 3; count += 1) await services.retryLedger.beginAttempt(key(first), 3);
  f.source.markWrittenBack = async () => ({ ...acknowledgement, clinicalExportId: '55555555-5555-4555-8555-555555555555' });
  assert.equal((await runWriteback(config, services)).failed, 1);
  assert.equal(services.retryLedger.get(key(first)).retired, false);
});
