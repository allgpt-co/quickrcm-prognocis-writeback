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

test('old complaint-route proof cannot verify or acknowledge Dictate/Transcribe', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clinical-ledger-route-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'verified.jsonl');
  const proof = { artifactHash: 'a'.repeat(64), jobKey: 'b'.repeat(64), ehrEncounterId: 'encounter-1' };
  const acknowledgement = { ...proof, clinicalExportId: '44444444-4444-4444-8444-444444444444',
    writtenBackAt: '2026-09-17T20:00:00.000Z' };
  // Existing files have no noteEntryMode field.
  await fs.writeFile(file, [
    { status: 'DRAFT_VERIFIED', ...proof },
    { status: 'WRITEBACK_ACKNOWLEDGED', ...acknowledgement }
  ].map(record => JSON.stringify(record)).join('\n') + '\n');
  const dictation = new VerificationLedger(file, 'dictate-transcribe');
  await dictation.init();
  assert.equal(dictation.has(proof.artifactHash), false);
  assert.equal(dictation.isAcknowledged(proof.artifactHash), false);
  await assert.rejects(dictation.markAcknowledged(acknowledgement), /without persisted verification proof/);
  await dictation.markVerified(proof);
  const pending = new VerificationLedger(file, 'dictate-transcribe');
  await pending.init();
  assert.equal(pending.has(proof.artifactHash), true);
  assert.equal(pending.isAcknowledged(proof.artifactHash), false);
  await pending.markAcknowledged(acknowledgement);
  for (const mode of ['section-screens', 'dictate-transcribe']) {
    const reopened = new VerificationLedger(file, mode);
    await reopened.init();
    assert.equal(reopened.has(proof.artifactHash), true);
    assert.equal(reopened.isAcknowledged(proof.artifactHash), true);
  }
});

