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
    quickRcm: {
      baseUrl: 'https://quickrcm.example.test',
      queuePath: '/queue',
      ackPath: '/queue/{jobId}/ack',
      requestTimeoutMs: 30_000
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
      auditFile: '.runtime/audit.jsonl'
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
    diagnosisMenu: '#diagnosis',
    diagnosisAddButton: '#diagnosis-add',
    diagnosisSearchInput: '#diagnosis-search',
    diagnosisResultRows: '#diagnosis-results tr',
    existingDiagnosisRows: '#existing-diagnoses tr',
    saveDraftButton: '#save-draft',
    draftSaveSuccess: '#draft-saved',
    draftStatus: '#draft-status'
  });
}

test('probe configuration needs identity and encounter selectors only', () => {
  assert.doesNotThrow(() => validateConfigObject(config()));
});

test('write mode requires all three clinical sections, ICD-10, and draft proof', () => {
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
