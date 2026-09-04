import fs from 'node:fs/promises';

export async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

export async function ensurePrivateFile(file) {
  await fs.chmod(file, 0o600);
}

