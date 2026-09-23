#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  closeBrowser,
  closeStaleLoginTargets,
  openBrowser,
  portalPage
} from './browser/session.mjs';
import { Care1960ApiSource } from './integrations/care1960-api.mjs';
import { PrognocisBrowser } from './integrations/prognocis-browser.mjs';
import { AuditLogger } from './runtime/audit.mjs';
import { loadConfig } from './runtime/config.mjs';
import { acquireRunLock } from './runtime/lock.mjs';
import { VerificationLedger } from './runtime/ledger.mjs';
import { RetryLedger } from './runtime/retry-ledger.mjs';
import { runWriteback } from './workflow/writeback.mjs';

function parseArgs(argv) {
  const args = { command: argv[0] ?? 'probe', config: 'config/writeback.json' };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--no-acknowledge') {
      args.noAcknowledge = true;
      continue;
    }
    if (token === '--config') args.config = argv[++index];
    else if (token === '--response') args.responseFile = argv[++index];
    else if (token === '--max-records') args.maxRecords = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${token}`);
    if (!argv[index] || argv[index].startsWith('--')) throw new Error(`Missing value for ${token}`);
  }
  if (!['probe', 'run', 'validate-config', 'validate-response'].includes(args.command)) {
    throw new Error(`Unknown command: ${args.command}`);
  }
  if (args.noAcknowledge && args.command !== 'run') {
    throw new Error('--no-acknowledge is supported only with run');
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
    await loadConfig(args.config, { requireSecrets: false, responseFile: args.responseFile });
    process.stdout.write('Configuration is structurally valid.\n');
    return;
  }

  const config = await loadConfig(args.config, {
    forceProbe: args.command !== 'run',
    responseFile: args.responseFile,
    sourceOnly: args.command === 'validate-response'
  });
  const source = new Care1960ApiSource(config.care1960, {
    apiKey: config.secrets.care1960ApiKey,
    bearerToken: config.secrets.care1960BearerToken
  });
  if (args.command === 'validate-response') {
    const records = await source.listAttestedArtifacts(args.maxRecords ?? 100);
    process.stdout.write(`${JSON.stringify({ mode: 'validate-response', validated: records.length, ehrWrites: 0 })}\n`);
    return;
  }
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
  let context;
  try {
    await audit.init();
    // Reject invalid API responses before opening or interacting with the EHR.
    await source.load();
    let browserDestination;
    const destination = {
      async prepare() {
        if (browserDestination) return;
        await closeStaleLoginTargets(config.browser.cdpEndpoint, config.prognocis.loginUrl);
        context ??= await openBrowser(config.browser);
        const destinationPage = await portalPage(context, config.prognocis.url);
        browserDestination = new PrognocisBrowser(
          destinationPage, config.prognocis, config.automation,
          { username: config.secrets.prognocisUsername, password: config.secrets.prognocisPassword }
        );
      },
      process(artifact, options) {
        return browserDestination.process(artifact, options);
      }
    };
    const ledger = new VerificationLedger(config.runtime.ledgerFile);
    await ledger.init();
    let retryLedger;
    if (config.automation.writeEnabled && !args.noAcknowledge
      && config.care1960.input === 'http' && config.automation.maxRetries !== undefined) {
      retryLedger = new RetryLedger(config.runtime.retryLedgerFile);
      await retryLedger.init();
    }
    const summary = await runWriteback(config, { source, destination, ledger, retryLedger, audit }, {
      acknowledgeSource: !args.noAcknowledge
    });
    // A supervised no-ack run must not consume a page or advance its cursor.
    if (args.command === 'run' && !args.noAcknowledge && summary.failed === 0) await source.commitCursor();
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.failed > 0 || summary.retryFailed > 0) process.exitCode = 1;
  } finally {
    if (context) await closeBrowser(context).catch(() => {});
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`care1960-prognocis-writeback: ${error.message}\n`);
  if (error.code === 'AUTH_REQUIRED') {
    process.stderr.write('Open the remote Chrome through noVNC, log in to PrognoCIS, then rerun probe mode.\n');
  }
  process.exitCode = 1;
});
