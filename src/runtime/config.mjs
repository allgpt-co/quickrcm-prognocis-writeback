import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { validateCare1960SourceConfig } from '../integrations/care1960-api.mjs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WRITE_ACKNOWLEDGEMENT = 'I_ACKNOWLEDGE_ATTESTED_CLINICAL_DRAFT_WRITES';

export function credentialsFromEnvironment(environment = process.env) {
  return {
    care1960ApiKey: environment.SUPABASE_ANON_KEY ?? '',
    care1960BearerToken: environment.SUPABASE_TENANT_API_KEY ?? '',
    // Accept the documented uppercase names; retain the lowercase aliases for
    // compatibility with older private environments.
    prognocisUsername: environment.prognosis_username ?? environment.PROGNOCIS_USERNAME ?? '',
    prognocisPassword: environment.prognosis_password ?? environment.PROGNOCIS_PASSWORD ?? '',
    writeAck: environment.CLINICAL_WRITE_ACK ?? ''
  };
}

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
  if (typeof value === 'string' && /TODO_|YOUR-/i.test(value)) {
    throw new Error(`${label} still contains an uncaptured placeholder`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
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

function requiredSelectors(selectors, prefix, keys) {
  for (const key of keys) nonEmpty(selectors[key], `${prefix}.selectors.${key}`);
}

function rejectPlaceholders(selectors, prefix) {
  for (const [key, value] of Object.entries(selectors)) {
    if (typeof value === 'string' && /^TODO_/i.test(value.trim())) {
      throw new Error(`Replace the uncaptured selector placeholder: ${prefix}.selectors.${key}`);
    }
  }
}

function validatePrognocis(config) {
  const prognocis = object(config.prognocis, 'prognocis');
  const selectors = object(prognocis.selectors, 'prognocis.selectors');
  const appUrl = validUrl(prognocis.url, 'prognocis.url');
  const loginUrl = validUrl(prognocis.loginUrl, 'prognocis.loginUrl');
  if (appUrl.origin !== loginUrl.origin) throw new Error('PrognoCIS app and login URLs must use the same origin');
  if (typeof prognocis.loginPerRun !== 'boolean') throw new Error('prognocis.loginPerRun must be boolean');
  pattern(prognocis.patientSearchUrlPattern, 'prognocis.patientSearchUrlPattern');
  pattern(prognocis.patientIdPattern, 'prognocis.patientIdPattern');
  pattern(prognocis.encounterHistoryUrlPattern, 'prognocis.encounterHistoryUrlPattern');
  pattern(prognocis.encounterIdPattern, 'prognocis.encounterIdPattern');
  pattern(prognocis.hpiComplaintIdPattern, 'prognocis.hpiComplaintIdPattern');
  const sectionUrlPatterns = object(
    prognocis.sectionUrlPatterns ?? {},
    'prognocis.sectionUrlPatterns'
  );
  for (const section of ['hpi', 'ros', 'physicalExamination']) {
    pattern(sectionUrlPatterns[section], `prognocis.sectionUrlPatterns.${section}`);
  }
  pattern(prognocis.sectionSaveUrlPattern, 'prognocis.sectionSaveUrlPattern');
  pattern(prognocis.draftSaveUrlPattern, 'prognocis.draftSaveUrlPattern');
  pattern(prognocis.draftSaveFrameUrlPattern, 'prognocis.draftSaveFrameUrlPattern');
  for (const [section, value] of Object.entries(prognocis.sectionSaveUrlPatterns ?? {})) {
    if (!['hpi', 'ros', 'physicalExamination'].includes(section)) throw new Error('Unknown section save pattern');
    pattern(value, `prognocis.sectionSaveUrlPatterns.${section}`);
  }
  pattern(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
  pattern(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');
  requiredSelectors(selectors, 'prognocis', [
    'selectPatient', 'patientFirstName', 'patientLastName', 'patientResultRows',
    'activePatientIdentity', 'encounterMenu', 'encounterRows', 'encounterDateCell',
    'encounterTypeCell', 'encounterIdAttribute', 'encounterEditorReady'
  ]);
  for (const key of Object.keys(selectors)) {
    if (/sign|finali[sz]e|submitClaim/i.test(key)) {
      throw new Error(`Clinical write-back must not configure a signing/finalization selector: ${key}`);
    }
  }
  rejectPlaceholders(selectors, 'prognocis');
  return { prognocis, selectors };
}

export function validateConfigObject(config) {
  const automation = object(config.automation, 'automation');
  const browser = object(config.browser, 'browser');
  const runtime = object(config.runtime, 'runtime');
  if (config.quickScribe !== undefined) {
    throw new Error('Legacy quickScribe configuration is no longer supported; use care1960 API input');
  }
  validateCare1960SourceConfig(config.care1960);
  const { prognocis, selectors } = validatePrognocis(config);
  if (prognocis.draftSaveStrategy !== undefined
    && !['explicit-button', 'sections-only'].includes(prognocis.draftSaveStrategy)) {
    throw new Error('prognocis.draftSaveStrategy must be explicit-button or sections-only');
  }

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
    if (!['localhost', '127.0.0.1', '[::1]'].includes(cdp.hostname)) {
      throw new Error('browser.cdpEndpoint must remain bound to localhost');
    }
  }
  nonEmpty(browser.userDataDir, 'browser.userDataDir');
  for (const key of ['actionTimeoutMs', 'navigationTimeoutMs']) {
    if (!Number.isInteger(browser[key]) || browser[key] < 1_000) {
      throw new Error(`browser.${key} must be an integer of at least 1000`);
    }
  }

  if (automation.writeEnabled) {
    nonEmpty(prognocis.hpiComplaintName, 'prognocis.hpiComplaintName');
    nonEmpty(prognocis.hpiComplaintIdAttribute, 'prognocis.hpiComplaintIdAttribute');
    nonEmpty(prognocis.hpiComplaintIdPattern, 'prognocis.hpiComplaintIdPattern');
    requiredSelectors(selectors, 'prognocis', [
      'encounterProviderCell',
      'hpiMenu', 'hpiField', 'hpiSaveButton',
      'hpiComplaintLookupButton', 'hpiComplaintSearchInput', 'hpiComplaintRows',
      'hpiComplaintNameCell', 'hpiComplaintSelectButton', 'hpiComplaintConfirmButton',
      'hpiActiveComplaintId',
      'rosMenu', 'rosField', 'rosSaveButton',
      'physicalExaminationMenu', 'physicalExaminationField', 'physicalExaminationSaveButton'
    ]);
    if (!selectors.sectionSaveSuccess && !prognocis.sectionSaveUrlPattern) {
      throw new Error('Write mode requires sectionSaveSuccess or sectionSaveUrlPattern');
    }
    if (prognocis.draftSaveStrategy !== 'sections-only') {
      requiredSelectors(selectors, 'prognocis', ['saveDraftButton']);
      if (!selectors.draftSaveSuccess && !prognocis.draftSaveUrlPattern) {
        throw new Error('Write mode requires draftSaveSuccess or draftSaveUrlPattern');
      }
    }
    nonEmpty(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
    nonEmpty(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');
    if (!selectors.draftStatus && !selectors.encounterStatusCell) {
      throw new Error('Write mode requires draftStatus or encounterStatusCell');
    }
    if (config.care1960.input === 'http') {
      nonEmpty(config.care1960.markWrittenBackUrl, 'care1960.markWrittenBackUrl');
    }
  }

  nonEmpty(runtime.lockFile, 'runtime.lockFile');
  nonEmpty(runtime.auditFile, 'runtime.auditFile');
  nonEmpty(runtime.ledgerFile, 'runtime.ledgerFile');
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
  { forceProbe = false, requireSecrets = true, responseFile, sourceOnly = false } = {}
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
  let parsed;
  try { parsed = JSON.parse(source); } catch { throw new Error('Configuration is not valid JSON'); }
  if (forceProbe && parsed.automation) parsed.automation.writeEnabled = false;
  if (responseFile) {
    parsed.care1960 = { ...parsed.care1960, input: 'response-file', responseFile };
  }
  const config = sourceOnly ? parsed : validateConfigObject(parsed);
  if (sourceOnly) validateCare1960SourceConfig(config.care1960);
  config.projectRoot = PROJECT_ROOT;
  config.configPath = resolved;
  if (!sourceOnly) {
    config.browser.projectRoot = PROJECT_ROOT;
    config.browser.userDataDir = path.resolve(PROJECT_ROOT, config.browser.userDataDir);
    config.runtime.lockFile = path.resolve(PROJECT_ROOT, config.runtime.lockFile);
    config.runtime.auditFile = path.resolve(PROJECT_ROOT, config.runtime.auditFile);
    config.runtime.ledgerFile = path.resolve(PROJECT_ROOT, config.runtime.ledgerFile);
  }
  for (const key of ['responseFile', 'requestFile', 'cursorFile']) {
    if (config.care1960[key]) config.care1960[key] = path.resolve(PROJECT_ROOT, config.care1960[key]);
  }
  config.secrets = credentialsFromEnvironment();
  if (requireSecrets && !sourceOnly) requireWriteApproval(config, config.secrets.writeAck);
  if (requireSecrets && config.care1960.input === 'http'
    && (!config.secrets.care1960ApiKey || !config.secrets.care1960BearerToken)) {
    throw new Error('SUPABASE_ANON_KEY and SUPABASE_TENANT_API_KEY are both required for HTTP input');
  }
  if (requireSecrets && !sourceOnly && config.prognocis.loginPerRun
    && (!config.secrets.prognocisUsername || !config.secrets.prognocisPassword)) {
    throw new Error('prognosis_username and prognosis_password are required for per-run login');
  }
  return config;
}
