import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from './private-files.mjs';

export class VerificationLedger {
  constructor(file) {
    this.file = file;
    this.hashes = new Set();
  }

  async init() {
    await ensurePrivateDirectory(path.dirname(this.file));
    let text = '';
    try {
      text = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const line of text.split('\n').filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.status === 'DRAFT_VERIFIED' && /^[a-f0-9]{64}$/.test(record.artifactHash)) {
        this.hashes.add(record.artifactHash);
      }
    }
    const handle = await fs.open(this.file, 'a', 0o600);
    await handle.close();
    await ensurePrivateFile(this.file);
  }

  has(artifactHash) {
    return this.hashes.has(artifactHash);
  }

  async markVerified({ artifactHash, jobKey, ehrEncounterId }) {
    if (!/^[a-f0-9]{64}$/.test(artifactHash)) throw new Error('Invalid artifact hash for ledger');
    if (!/^[a-f0-9]{64}$/.test(jobKey)) throw new Error('Invalid job key for ledger');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(ehrEncounterId)) {
      throw new Error('Invalid EHR encounter ID for ledger');
    }
    if (this.hashes.has(artifactHash)) return false;
    await fs.appendFile(this.file, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      status: 'DRAFT_VERIFIED',
      artifactHash,
      jobKey,
      ehrEncounterId
    })}\n`, { mode: 0o600 });
    this.hashes.add(artifactHash);
    return true;
  }
}

