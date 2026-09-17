import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VerificationLedger } from '../src/runtime/ledger.mjs';

test('verification ledger persists only non-PHI draft proof and is idempotent', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clinical-ledger-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'verified.jsonl');
  const proof = {
    artifactHash: 'a'.repeat(64),
    jobKey: 'b'.repeat(64),
    ehrEncounterId: 'encounter-1'
  };
  const ledger = new VerificationLedger(file);
  await ledger.init();
  assert.equal(await ledger.markVerified(proof), true);
  assert.equal(await ledger.markVerified(proof), false);
  assert.equal(ledger.isAcknowledged(proof.artifactHash), false);
  const acknowledgement = {
    artifactHash: proof.artifactHash,
    jobKey: proof.jobKey,
    clinicalExportId: '44444444-4444-4444-8444-444444444444',
    writtenBackAt: '2026-09-17T20:00:00.000Z'
  };
  assert.equal(await ledger.markAcknowledged(acknowledgement), true);
  assert.equal(await ledger.markAcknowledged(acknowledgement), false);
  const reopened = new VerificationLedger(file);
  await reopened.init();
  assert.equal(reopened.has(proof.artifactHash), true);
  assert.equal(reopened.isAcknowledged(proof.artifactHash), true);
  const stored = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(stored, /patient|dob|hpi|ros/i);
  assert.match(stored, /WRITEBACK_ACKNOWLEDGED/);
});

test('verification ledger rejects orphan acknowledgement state without draft proof', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clinical-ledger-orphan-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'verified.jsonl');
  await fs.writeFile(file, `${JSON.stringify({
    timestamp: '2026-09-17T20:00:01.000Z',
    status: 'WRITEBACK_ACKNOWLEDGED',
    artifactHash: 'a'.repeat(64),
    jobKey: 'b'.repeat(64),
    clinicalExportId: '44444444-4444-4444-8444-444444444444',
    writtenBackAt: '2026-09-17T20:00:00.000Z'
  })}\n`, { mode: 0o600 });
  const ledger = new VerificationLedger(file);
  await assert.rejects(ledger.init(), /without persisted draft verification proof/i);
});

