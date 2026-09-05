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
  if (typeof value === 'string' && /TODO_|YOUR-/i.test(value)) {
    throw new Error(`${label} still contains an uncaptured placeholder`);
  }
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

function validateQuickScribe(config) {
  const quickScribe = object(config.quickScribe, 'quickScribe');
  const selectors = object(quickScribe.selectors, 'quickScribe.selectors');
  const appUrl = validUrl(quickScribe.url, 'quickScribe.url');
  const queueUrl = validUrl(quickScribe.attestedNotesUrl, 'quickScribe.attestedNotesUrl');
  if (appUrl.origin !== queueUrl.origin) {
    throw new Error('QuickScribe app and attested-notes URLs must use the same origin');
  }
  pattern(quickScribe.noteIdUrlPattern, 'quickScribe.noteIdUrlPattern');
  pattern(quickScribe.patientNamePattern, 'quickScribe.patientNamePattern');
  pattern(quickScribe.diagnosisPageUrlPattern, 'quickScribe.diagnosisPageUrlPattern');
  requiredSelectors(selectors, 'quickScribe', [
    'authenticatedMarker', 'noteRows', 'noteStatus',
    'noteDetailRoot', 'detailStatus', 'attestationAt', 'attestationBy', 'finalNote',
    'acceptedDiagnosisRows', 'diagnosisCode'
  ]);
  if (!selectors.noteIdAttribute && !quickScribe.noteIdUrlPattern) {
    throw new Error('QuickScribe requires a stable noteIdAttribute or noteIdUrlPattern');
  }
  if (!selectors.noteOpenLink && !quickScribe.noteIdUrlPattern) {
    throw new Error('QuickScribe row-click navigation requires noteIdUrlPattern');
  }
  if (selectors.queuePatientName) {
    requiredSelectors(selectors, 'quickScribe', [
      'queuePatientName', 'queuePatientId', 'queueServiceDate',
      'patientSearchInput', 'patientRows', 'patientNameCell', 'patientDobCell',
      'appointmentRows', 'appointmentPatientNameCell', 'appointmentPatientIdCell',
      'appointmentTypeCell', 'diagnosisOpenButton'
    ]);
    validUrl(quickScribe.patientDirectoryUrl, 'quickScribe.patientDirectoryUrl');
    validUrl(quickScribe.appointmentDirectoryUrl, 'quickScribe.appointmentDirectoryUrl');
    nonEmpty(quickScribe.patientNamePattern, 'quickScribe.patientNamePattern');
    const ids = object(quickScribe.appointmentIdByJobId, 'quickScribe.appointmentIdByJobId');
    if (Object.keys(ids).length === 0 && !selectors.appointmentIdAttribute) {
      throw new Error('Joined QuickScribe UI mode requires appointmentIdByJobId or appointmentIdAttribute');
    }
    object(quickScribe.appointmentTypeMap ?? {}, 'quickScribe.appointmentTypeMap');
  } else {
    requiredSelectors(selectors, 'quickScribe', [
      'patientId', 'patientFirstName', 'patientLastName', 'patientDob',
      'appointmentId', 'serviceDate', 'appointmentType'
    ]);
  }
  rejectPlaceholders(selectors, 'quickScribe');
}

function validatePrognocis(config) {
  const prognocis = object(config.prognocis, 'prognocis');
  const selectors = object(prognocis.selectors, 'prognocis.selectors');
  const appUrl = validUrl(prognocis.url, 'prognocis.url');
  const loginUrl = validUrl(prognocis.loginUrl, 'prognocis.loginUrl');
  if (appUrl.origin !== loginUrl.origin) throw new Error('PrognoCIS app and login URLs must use the same origin');
  if (typeof prognocis.loginPerRun !== 'boolean') throw new Error('prognocis.loginPerRun must be boolean');
  pattern(prognocis.patientSearchUrlPattern, 'prognocis.patientSearchUrlPattern');
  pattern(prognocis.encounterHistoryUrlPattern, 'prognocis.encounterHistoryUrlPattern');
  pattern(prognocis.encounterIdPattern, 'prognocis.encounterIdPattern');
  const sectionUrlPatterns = object(
    prognocis.sectionUrlPatterns ?? {},
    'prognocis.sectionUrlPatterns'
  );
  for (const section of ['hpi', 'ros', 'physicalExamination']) {
    pattern(sectionUrlPatterns[section], `prognocis.sectionUrlPatterns.${section}`);
  }
  pattern(prognocis.sectionSaveUrlPattern, 'prognocis.sectionSaveUrlPattern');
  pattern(prognocis.draftSaveUrlPattern, 'prognocis.draftSaveUrlPattern');
  pattern(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
  pattern(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');
  if (prognocis.diagnosisSearchPath) {
    const diagnosisSearchUrl = new URL(prognocis.diagnosisSearchPath, appUrl);
    if (diagnosisSearchUrl.origin !== appUrl.origin) {
      throw new Error('prognocis.diagnosisSearchPath must remain same-origin');
    }
  }
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
  validateQuickScribe(config);
  const { prognocis, selectors } = validatePrognocis(config);

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

  if (automation.writeEnabled) {
    requiredSelectors(selectors, 'prognocis', [
      'hpiMenu', 'hpiField', 'hpiSaveButton',
      'rosMenu', 'rosField', 'rosSaveButton',
      'physicalExaminationMenu', 'physicalExaminationField', 'physicalExaminationSaveButton',
      'diagnosisMenu', 'diagnosisAddButton', 'diagnosisSearchInput',
      'diagnosisResultRows', 'existingDiagnosisRows', 'saveDraftButton'
    ]);
    if (!selectors.sectionSaveSuccess && !prognocis.sectionSaveUrlPattern) {
      throw new Error('Write mode requires sectionSaveSuccess or sectionSaveUrlPattern');
    }
    if (!selectors.draftSaveSuccess && !prognocis.draftSaveUrlPattern) {
      throw new Error('Write mode requires draftSaveSuccess or draftSaveUrlPattern');
    }
    nonEmpty(prognocis.draftStatusPattern, 'prognocis.draftStatusPattern');
    nonEmpty(prognocis.editableStatusPattern, 'prognocis.editableStatusPattern');
    if (!selectors.draftStatus && !selectors.encounterStatusCell) {
      throw new Error('Write mode requires draftStatus or encounterStatusCell');
    }
    if (selectors.diagnosisSelectButton && !selectors.diagnosisConfirmButton) {
      throw new Error('Diagnosis checkbox selection requires diagnosisConfirmButton');
    }
  }
  if (selectors.hpiTemplateButton) {
    requiredSelectors(selectors, 'prognocis', ['hpiTemplateResultRows']);
    const templates = object(prognocis.hpiTemplateByAppointmentType, 'prognocis.hpiTemplateByAppointmentType');
    if (Object.keys(templates).length === 0) {
      throw new Error('prognocis.hpiTemplateByAppointmentType must contain exact mappings');
    }
  }
  if (selectors.hpiComplaintLookupButton) {
    requiredSelectors(selectors, 'prognocis', [
      'hpiComplaintSearchInput', 'hpiComplaintRows', 'hpiComplaintNameCell',
      'hpiComplaintSelectButton', 'hpiComplaintConfirmButton'
    ]);
    const complaints = object(
      prognocis.hpiComplaintByAppointmentType,
      'prognocis.hpiComplaintByAppointmentType'
    );
    if (Object.keys(complaints).length === 0) {
      throw new Error('prognocis.hpiComplaintByAppointmentType must contain exact mappings');
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
  config.runtime.ledgerFile = path.resolve(PROJECT_ROOT, config.runtime.ledgerFile);
  config.secrets = {
    prognocisUsername: process.env.PROGNOCIS_USERNAME ?? '',
    prognocisPassword: process.env.PROGNOCIS_PASSWORD ?? '',
    writeAck: process.env.CLINICAL_WRITE_ACK ?? ''
  };
  requireWriteApproval(config, config.secrets.writeAck);
  if (requireSecrets && config.prognocis.loginPerRun
    && (!config.secrets.prognocisUsername || !config.secrets.prognocisPassword)) {
    throw new Error('PROGNOCIS_USERNAME and PROGNOCIS_PASSWORD are required for per-run login');
  }
  return config;
}
