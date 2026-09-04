import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WRITE_ACKNOWLEDGEMENT = 'I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
}

function validUrl(value, label, { localHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(localHttp && local && parsed.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS${localHttp ? ' except on localhost' : ''}`);
  }
  return parsed;
}

function pattern(value, label) {
  if (!value) return;
  try {
    new RegExp(value);
  } catch {
    throw new Error(`${label} must be a valid regular expression`);
  }
}

function requiredSelectors(selectors, keys) {
  for (const key of keys) nonEmpty(selectors[key], `prognocis.selectors.${key}`);
}

function rejectUnsafeSelectors(selectors) {
  for (const [key, value] of Object.entries(selectors)) {
    if (/sign|finali[sz]e|submitClaim/i.test(key)) {
      throw new Error(`Clinical write-back must not configure a signing/finalization selector: ${key}`);
    }
    if (typeof value === 'string' && /^TODO_/i.test(value.trim())) {
      throw new Error(`Replace the uncaptured selector placeholder: prognocis.selectors.${key}`);
    }
  }
}

export function validateConfigObject(config) {
  const automation = object(config.automation, 'automation');
  const browser = object(config.browser, 'browser');
  const quickRcm = object(config.quickRcm, 'quickRcm');
  const prognocis = object(config.prognocis, 'prognocis');
  const selectors = object(prognocis.selectors, 'prognocis.selectors');
  const runtime = object(config.runtime, 'runtime');

  if (typeof automation.writeEnabled !== 'boolean') throw new Error('automation.writeEnabled must be boolean');
  if (automation.draftOnly !== true) throw new Error('automation.draftOnly must remain true');
  if (!Number.isInteger(automation.maxRecordsPerRun)
    || automation.maxRecordsPerRun < 1 || automation.maxRecordsPerRun > 100) {
    throw new Error('automation.maxRecordsPerRun must be an integer from 1 to 100');
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: automation.timezone }).format();
  } catch {
    throw new Error('automation.timezone must be a valid IANA timezone');
  }

  if (typeof browser.headless !== 'boolean') throw new Error('browser.headless must be boolean');
  if (browser.cdpEndpoint) {
    const cdp = validUrl(browser.cdpEndpoint, 'browser.cdpEndpoint', { localHttp: true });
    if (!['localhost', '127.0.0.1', '::1'].includes(cdp.hostname)) {
      throw new Error('browser.cdpEndpoint must remain bound to localhost');
    }
  }
  nonEmpty(browser.userDataDir, 'browser.userDataDir');
  for (const key of ['actionTimeoutMs', 'navigationTimeoutMs']) {
    if (!Number.isInteger(browser[key]) || browser[key] < 1_000) {
      throw new Error(`browser.${key} must be an integer of at least 1000`);
    }
  }

  validUrl(quickRcm.baseUrl, 'quickRcm.baseUrl', { localHttp: true });
  nonEmpty(quickRcm.queuePath, 'quickRcm.queuePath');
  nonEmpty(quickRcm.ackPath, 'quickRcm.ackPath');
  if (!quickRcm.queuePath.startsWith('/') || !quickRcm.ackPath.startsWith('/')) {
    throw new Error('QuickRCM endpoint paths must start with /');
  }
  if (!quickRcm.ackPath.includes('{jobId}')) throw new Error('quickRcm.ackPath must contain {jobId}');
  if (!Number.isInteger(quickRcm.requestTimeoutMs) || quickRcm.requestTimeoutMs < 1_000) {
    throw new Error('quickRcm.requestTimeoutMs must be at least 1000');
  }

  const appUrl = validUrl(prognocis.url, 'prognocis.url');
  const loginUrl = validUrl(prognocis.loginUrl, 'prognocis.loginUrl');
  if (appUrl.origin !== loginUrl.origin) throw new Error('PrognoCIS app and login URLs must use the same origin');
  if (typeof prognocis.loginPerRun !== 'boolean') throw new Error('prognocis.loginPerRun must be boolean');
  pattern(prognocis.patientSearchUrlPattern, 'prognocis.patientSearchUrlPattern');
  pattern(prognocis.sectionSaveUrlPattern, 'prognocis.sectionSaveUrlPattern');
  pattern(prognocis.draftSaveUrlPattern, 'prognocis.draftSaveUrlPattern');
  pattern(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
  pattern(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');

  requiredSelectors(selectors, [
    'selectPatient', 'patientFirstName', 'patientLastName', 'patientResultRows',
    'activePatientIdentity', 'encounterMenu', 'encounterRows', 'encounterDateCell',
    'encounterTypeCell', 'encounterIdAttribute', 'encounterEditorReady'
  ]);
  rejectUnsafeSelectors(selectors);

  if (automation.writeEnabled) {
    requiredSelectors(selectors, [
      'hpiMenu', 'hpiField', 'hpiSaveButton',
      'rosMenu', 'rosField', 'rosSaveButton',
      'physicalExaminationMenu', 'physicalExaminationField', 'physicalExaminationSaveButton',
      'diagnosisMenu', 'diagnosisAddButton', 'diagnosisSearchInput',
      'diagnosisResultRows', 'existingDiagnosisRows',
      'saveDraftButton', 'draftStatus'
    ]);
    if (!selectors.sectionSaveSuccess && !prognocis.sectionSaveUrlPattern) {
      throw new Error('Write mode requires sectionSaveSuccess or sectionSaveUrlPattern');
    }
    if (!selectors.draftSaveSuccess && !prognocis.draftSaveUrlPattern) {
      throw new Error('Write mode requires draftSaveSuccess or draftSaveUrlPattern');
    }
    nonEmpty(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
    nonEmpty(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');
  }
  if (selectors.hpiTemplateButton) {
    requiredSelectors(selectors, ['hpiTemplateResultRows']);
    const templates = object(prognocis.hpiTemplateByAppointmentType, 'prognocis.hpiTemplateByAppointmentType');
    if (Object.keys(templates).length === 0) {
      throw new Error('prognocis.hpiTemplateByAppointmentType must contain exact mappings');
    }
  }

  nonEmpty(runtime.lockFile, 'runtime.lockFile');
  nonEmpty(runtime.auditFile, 'runtime.auditFile');
  return config;
}

export function requireWriteApproval(config, acknowledgement) {
  if (!config.automation.writeEnabled) return;
  if (config.automation.draftOnly !== true) throw new Error('Only draft writes are permitted');
  if (acknowledgement !== WRITE_ACKNOWLEDGEMENT) {
    throw new Error(`CLINICAL_WRITE_ACK must be ${WRITE_ACKNOWLEDGEMENT}`);
  }
}

export async function loadConfig(
  configPath = 'config/writeback.json',
  { forceProbe = false, requireSecrets = true } = {}
) {
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
  const resolved = path.resolve(PROJECT_ROOT, configPath);
  let source;
  try {
    source = await fs.readFile(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration not found at ${resolved}; copy config/writeback.example.json first`);
    }
    throw error;
  }
  const parsed = JSON.parse(source);
  if (forceProbe) parsed.automation.writeEnabled = false;
  const config = validateConfigObject(parsed);
  config.projectRoot = PROJECT_ROOT;
  config.configPath = resolved;
  config.browser.projectRoot = PROJECT_ROOT;
  config.browser.userDataDir = path.resolve(PROJECT_ROOT, config.browser.userDataDir);
  config.runtime.lockFile = path.resolve(PROJECT_ROOT, config.runtime.lockFile);
  config.runtime.auditFile = path.resolve(PROJECT_ROOT, config.runtime.auditFile);
  config.secrets = {
    quickRcmApiKey: process.env.QUICKRCM_API_KEY ?? '',
    prognocisUsername: process.env.PROGNOCIS_USERNAME ?? '',
    prognocisPassword: process.env.PROGNOCIS_PASSWORD ?? '',
    writeAck: process.env.CLINICAL_WRITE_ACK ?? ''
  };
  requireWriteApproval(config, config.secrets.writeAck);
  if (requireSecrets && !config.secrets.quickRcmApiKey) throw new Error('QUICKRCM_API_KEY is required');
  if (requireSecrets && config.prognocis.loginPerRun
    && (!config.secrets.prognocisUsername || !config.secrets.prognocisPassword)) {
    throw new Error('PROGNOCIS_USERNAME and PROGNOCIS_PASSWORD are required for per-run login');
  }
  return config;
}
