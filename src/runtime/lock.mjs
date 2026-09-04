import fs from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDirectory } from './private-files.mjs';

export async function acquireRunLock(lockFile, staleAfterMs = 6 * 60 * 60 * 1000) {
  await ensurePrivateDirectory(path.dirname(lockFile));
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  try {
    const handle = await fs.open(lockFile, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.close();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const stat = await fs.stat(lockFile);
    if (Date.now() - stat.mtimeMs <= staleAfterMs) {
      const lockError = new Error('Another clinical write-back run is active');
      lockError.code = 'RUN_ALREADY_ACTIVE';
      throw lockError;
    }
    await fs.unlink(lockFile);
    const handle = await fs.open(lockFile, 'wx', 0o600);
    await handle.writeFile(payload);
    await handle.close();
  }
  return async () => {
    try {
      await fs.unlink(lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
}

