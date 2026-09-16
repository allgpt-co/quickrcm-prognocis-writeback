import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requireWriteApproval,
  validateConfigObject,
  WRITE_ACKNOWLEDGEMENT
} from '../src/runtime/config.mjs';

function config() {
  return {
    automation: {
      timezone: 'America/Chicago',
      writeEnabled: false,
      draftOnly: true,
      maxRecordsPerRun: 10
    },
    browser: {
      cdpEndpoint: 'http://127.0.0.1:9223',
      headless: false,
      userDataDir: '.runtime/browser',
      actionTimeoutMs: 20_000,
      navigationTimeoutMs: 45_000
    },
    care1960: {
      input: 'response-file',
      responseFile: '.runtime/care1960-response.json',
      orgId: '11111111-1111-4111-8111-111111111111'
    },
    prognocis: {
      url: 'https://ehr.example.test/scrMasterFrame.jsp',
      loginUrl: 'https://ehr.example.test/scrUserLogin.jsp',
      loginPerRun: false,
      patientSearchUrlPattern: 'search',
      sectionSaveUrlPattern: '',
      draftSaveUrlPattern: '',
      draftStatusPattern: '^Draft$',
      editableStatusPattern: '^(Draft|Open|In Progress)$',
      hpiTemplateByAppointmentType: {},
      selectors: {
        selectPatient: '#select-patient',
        patientFirstName: '#first-name',
        patientLastName: '#last-name',
        patientResultRows: '#patients tr',
        patientResultIdAttribute: 'data-patient-id',
        activePatientIdentity: '#active-patient',
        encounterMenu: '#encounter-menu',
        encounterRows: '#encounters tr',
        encounterDateCell: '.date',
        encounterTypeCell: '.type',
        encounterIdAttribute: 'data-encounter-id',
        encounterEditorReady: '#editor'
      }
    },
    runtime: {
      lockFile: '.runtime/writeback.lock',
      auditFile: '.runtime/audit.jsonl',
      ledgerFile: '.runtime/verified.jsonl'
    }
  };
}

function addWriteSelectors(value) {
  Object.assign(value.prognocis.selectors, {
    hpiMenu: '#hpi', hpiField: '#hpi-field', hpiSaveButton: '#hpi-save',
    rosMenu: '#ros', rosField: '#ros-field', rosSaveButton: '#ros-save',
    physicalExaminationMenu: '#pe',
    physicalExaminationField: '#pe-field',
    physicalExaminationSaveButton: '#pe-save',
    sectionSaveSuccess: '#section-saved',
    saveDraftButton: '#save-draft',
    draftSaveSuccess: '#draft-saved',
    draftStatus: '#draft-status'
  });
}

test('probe requires an API response source and PrognoCIS identity selectors', () => {
  assert.doesNotThrow(() => validateConfigObject(config()));
  const missingSource = config();
  delete missingSource.care1960;
  assert.throws(() => validateConfigObject(missingSource), /care1960/);
  const legacy = config();
  legacy.quickScribe = {};
  assert.throws(() => validateConfigObject(legacy), /no longer supported/);
  const missingIdentity = config();
  delete missingIdentity.prognocis.selectors.patientResultIdAttribute;
  assert.throws(() => validateConfigObject(missingIdentity), /patientResultIdAttribute/);
});

test('write mode requires all three clinical sections and draft proof without diagnosis selectors', () => {
  const value = config();
  value.automation.writeEnabled = true;
  assert.throws(() => validateConfigObject(value), /hpiMenu/);
  addWriteSelectors(value);
  assert.doesNotThrow(() => validateConfigObject(value));
});

test('configuration refuses sign, finalize, and placeholder selectors', () => {
  const signing = config();
  signing.prognocis.selectors.signButton = '#sign';
  assert.throws(() => validateConfigObject(signing), /signing\/finalization/i);
  const placeholder = config();
  placeholder.prognocis.selectors.encounterRows = 'TODO_CAPTURE_ROWS';
  assert.throws(() => validateConfigObject(placeholder), /placeholder/i);
});

test('CDP control endpoint must remain local to the automation server', () => {
  const value = config();
  value.browser.cdpEndpoint = 'https://public.example.test:9223';
  assert.throws(() => validateConfigObject(value), /localhost/i);
});

test('draft writes require the exact operator acknowledgement', () => {
  const value = config();
  value.automation.writeEnabled = true;
  assert.throws(() => requireWriteApproval(value, ''), /CLINICAL_WRITE_ACK/);
  assert.doesNotThrow(() => requireWriteApproval(value, WRITE_ACKNOWLEDGEMENT));
});
