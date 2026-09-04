#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { newAutomationPage, openBrowser, closeBrowser } from './browser/session.mjs';
import { QuickRcmClient } from './integrations/quickrcm-client.mjs';
import { PrognocisBrowser } from './integrations/prognocis-browser.mjs';
import { AuditLogger } from './runtime/audit.mjs';
import { loadConfig } from './runtime/config.mjs';
import { acquireRunLock } from './runtime/lock.mjs';
import { runWriteback } from './workflow/writeback.mjs';

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'probe', config: 'config/writeback.json' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') args.config = argv[++index];
    else if (token === '--max-records') args.maxRecords = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (!['probe', 'run', 'validate-config'].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (args.maxRecords !== undefined
    && (!Number.isInteger(args.maxRecords) || args.maxRecords < 1 || args.maxRecords > 100)) {
    throw new Error('--max-records must be an integer from 1 to 100');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'validate-config') {
    await loadConfig(args.config, { requireSecrets: false });
    process.stdout.write('Configuration is structurally valid.\n');
    return;
  }

  const config = await loadConfig(args.config, { forceProbe: args.command === 'probe' });
  if (args.command === 'run' && !config.automation.writeEnabled) {
    throw new Error('Set automation.writeEnabled=true only after the supervised canary; use npm run probe before then');
  }
  if (args.maxRecords !== undefined) {
    config.automation.maxRecordsPerRun = Math.min(
      config.automation.maxRecordsPerRun,
      args.maxRecords
    );
  }

  const releaseLock = await acquireRunLock(config.runtime.lockFile);
  const audit = new AuditLogger(config.runtime.auditFile, randomUUID());
  await audit.init();
  let context;
  try {
    const client = new QuickRcmClient(config.quickRcm, config.secrets.quickRcmApiKey);
    context = await openBrowser(config.browser);
    const page = await newAutomationPage(context, config.prognocis.url);
    const destination = new PrognocisBrowser(
      page,
      config.prognocis,
      config.automation,
      {
        username: config.secrets.prognocisUsername,
        password: config.secrets.prognocisPassword
      }
    );
    const summary = await runWriteback(config, { client, destination, audit });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    if (context) await closeBrowser(context).catch(() => {});
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`quickrcm-prognocis-writeback: ${error.message}\n`);
  if (error.code === 'AUTH_REQUIRED') {
    process.stderr.write('Open the remote Chrome through noVNC, log in to PrognoCIS, then rerun probe mode.\n');
  }
  process.exitCode = 1;
});

