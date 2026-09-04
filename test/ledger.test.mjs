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
  const reopened = new VerificationLedger(file);
  await reopened.init();
  assert.equal(reopened.has(proof.artifactHash), true);
  const stored = await fs.readFile(file, 'utf8');
  assert.doesNotMatch(stored, /patient|dob|hpi|ros/i);
});

