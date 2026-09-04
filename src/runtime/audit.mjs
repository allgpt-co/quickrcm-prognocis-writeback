import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDirectory, ensurePrivateFile } from './private-files.mjs';

const ALLOWED_FIELDS = new Set([
  'timestamp', 'runId', 'level', 'event', 'jobKey', 'artifactHash',
  'mode', 'status', 'count', 'durationMs', 'errorCode'
]);

function safeDetails(details) {
  return Object.fromEntries(Object.entries(details ?? {})
    .filter(([key, value]) => ALLOWED_FIELDS.has(key) && value !== undefined));
}

export class AuditLogger {
  constructor(file, runId) {
    this.file = file;
    this.runId = runId;
  }

  async init() {
    await ensurePrivateDirectory(path.dirname(this.file));
    const handle = await fs.open(this.file, 'a', 0o600);
    await handle.close();
    await ensurePrivateFile(this.file);
  }

  async write(level, event, details = {}) {
    const record = safeDetails({
      timestamp: new Date().toISOString(),
      runId: this.runId,
      level,
      event,
      ...details
    });
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    process.stdout.write(`${level} ${event}${record.status ? ` ${record.status}` : ''}\n`);
  }

  info(event, details) { return this.write('INFO', event, details); }
  error(event, details) { return this.write('ERROR', event, details); }
}

