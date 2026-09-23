import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory, ensurePrivateFile } from './private-files.mjs';

const validKey = (key) => /^[a-f0-9]{64}$/.test(key);

// Used under the worker's exclusive run lock. Atomic replacement and fsync
// persist the attempt BEFORE browser work, including across worker crashes.
// Job keys include the tenant; changing note content does not reset the budget.
export class RetryLedger {
  constructor(file) {
    this.file = file;
    this.jobs = {};
  }

  async init() {
    await ensurePrivateDirectory(path.dirname(this.file));
    let state;
    try {
      state = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#save({});
      return;
    }
    if (state?.version !== 1 || !state.jobs || typeof state.jobs !== 'object'
      || Array.isArray(state.jobs) || Object.entries(state.jobs).some(([key, value]) =>
        !validKey(key) || !value || !Number.isSafeInteger(value.attempts) || value.attempts < 0
        || typeof value.retired !== 'boolean' || (value.retired && value.attempts === 0))) {
      throw new Error('Retry ledger is invalid; refusing to reset attempt counts');
    }
    this.jobs = state.jobs;
    await ensurePrivateFile(this.file);
  }

  get(jobKey) {
    if (!validKey(jobKey)) throw new Error('Invalid job key for retry ledger');
    return { ...(this.jobs[jobKey] ?? { attempts: 0, retired: false }) };
  }

  async beginAttempt(jobKey, maxAttempts) {
    const state = this.get(jobKey);
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || state.retired || state.attempts >= maxAttempts) {
      throw new Error('Retry limit reached; another EHR attempt is not permitted');
    }
    state.attempts += 1;
    await this.#save({ ...this.jobs, [jobKey]: state });
    return state.attempts;
  }

  async cancelAttempt(jobKey) {
    // An explicit authentication failure is an operator/session issue, not a
    // failed clinical record. The workflow halts rather than draining the queue.
    const state = this.get(jobKey);
    if (state.retired || state.attempts < 1) throw new Error('No retry attempt to cancel');
    state.attempts -= 1;
    await this.#save({ ...this.jobs, [jobKey]: state });
  }

  async markRetired(jobKey) {
    const state = this.get(jobKey);
    if (state.attempts < 1) throw new Error('Cannot retire an unattempted job');
    await this.#save({ ...this.jobs, [jobKey]: { ...state, retired: true } });
  }

  async #save(jobs) {
    const temporary = `${this.file}.tmp-${randomUUID()}`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, jobs })}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
      const directory = await fs.open(path.dirname(this.file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      this.jobs = jobs;
    } finally {
      await fs.unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
