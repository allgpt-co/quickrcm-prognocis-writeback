import test from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialsFromEnvironment,
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
  value.prognocis.hpiComplaintName = 'Wellness exam';
  value.prognocis.hpiComplaintIdAttribute = 'onclick';
  value.prognocis.hpiComplaintIdPattern = "sendCODE\\('(?:[^']*)','([^']+)'";
  Object.assign(value.prognocis.selectors, {
    encounterProviderCell: '.provider',
    hpiMenu: '#hpi', hpiField: '#hpi-field', hpiSaveButton: '#hpi-save',
    hpiComplaintLookupButton: '#hpi-complaint',
    hpiComplaintSearchInput: '#hpi-complaint-search',
    hpiComplaintRows: '#hpi-complaint-results tr',
    hpiComplaintNameCell: '.name',
    hpiComplaintSelectButton: 'input[type="checkbox"]',
    hpiComplaintConfirmButton: '#hpi-complaint-confirm',
    hpiActiveComplaintId: '#hpi-active-complaint-id',
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

test('section-only write strategy needs all narrative saves and draft proof, but no extra save control', () => {
  const value = config();
  value.automation.writeEnabled = true;
  addWriteSelectors(value);
  value.prognocis.draftSaveStrategy = 'sections-only';
  delete value.prognocis.selectors.saveDraftButton;
  delete value.prognocis.selectors.draftSaveSuccess;
  assert.doesNotThrow(() => validateConfigObject(value));
  delete value.prognocis.selectors.hpiSaveButton;
  assert.throws(() => validateConfigObject(value), /hpiSaveButton/);
  const unknown = config();
  unknown.prognocis.draftSaveStrategy = 'unknown';
  assert.throws(() => validateConfigObject(unknown), /draftSaveStrategy/);
});

test('probe requires an API response source and PrognoCIS identity selectors', () => {
  assert.doesNotThrow(() => validateConfigObject(config()));
  const missingSource = config();
  delete missingSource.care1960;
  assert.throws(() => validateConfigObject(missingSource), /care1960/);
  const legacy = config();
  legacy.quickScribe = {};
  assert.throws(() => validateConfigObject(legacy), /no longer supported/);
  const withoutRetainedPatientId = config();
  delete withoutRetainedPatientId.prognocis.selectors.patientResultIdAttribute;
  assert.doesNotThrow(() => validateConfigObject(withoutRetainedPatientId));
});

test('write mode requires all three clinical sections and draft proof without diagnosis selectors', () => {
  const value = config();
  value.automation.writeEnabled = true;
  addWriteSelectors(value);
  delete value.prognocis.selectors.hpiMenu;
  assert.throws(() => validateConfigObject(value), /hpiMenu/);
  value.prognocis.selectors.hpiMenu = '#hpi';
  assert.doesNotThrow(() => validateConfigObject(value));
});

test('write mode requires an exact universal HPI complaint and active-ID proof selectors', () => {
  const valid = config();
  valid.automation.writeEnabled = true;
  addWriteSelectors(valid);
  assert.doesNotThrow(() => validateConfigObject(valid));
  for (const field of ['hpiComplaintName', 'hpiComplaintIdAttribute', 'hpiComplaintIdPattern']) {
    const value = structuredClone(valid);
    delete value.prognocis[field];
    assert.throws(() => validateConfigObject(value), new RegExp(field));
  }
  for (const selector of [
    'encounterProviderCell', 'hpiComplaintLookupButton', 'hpiComplaintSearchInput',
    'hpiComplaintRows', 'hpiComplaintNameCell', 'hpiComplaintSelectButton',
    'hpiComplaintConfirmButton', 'hpiActiveComplaintId'
  ]) {
    const value = structuredClone(valid);
    delete value.prognocis.selectors[selector];
    assert.throws(() => validateConfigObject(value), new RegExp(selector));
  }
});

test('HTTP write mode requires a same-origin mark-written-back endpoint', () => {
  const value = config();
  value.automation.writeEnabled = true;
  addWriteSelectors(value);
  value.care1960 = {
    input: 'http',
    orgId: '11111111-1111-4111-8111-111111111111',
    apiUrl: 'https://api.example.test/rest/v1/rpc/care1960_get_attested_clinical_records',
    requestFile: '.runtime/request.json',
    timeoutMs: 1_000
  };
  assert.throws(() => validateConfigObject(value), /markWrittenBackUrl/);
  value.care1960.markWrittenBackUrl = 'https://api.example.test/rest/v1/rpc/care1960_mark_clinical_record_written_back';
  assert.doesNotThrow(() => validateConfigObject(value));
  value.care1960.markWrittenBackUrl = 'https://other.example.test/rest/v1/rpc/care1960_mark_clinical_record_written_back';
  assert.throws(() => validateConfigObject(value), /same origin/i);
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

test('credential loading reuses production Supabase and PrognoCIS env names', () => {
  assert.equal(typeof credentialsFromEnvironment, 'function');
  assert.deepEqual(credentialsFromEnvironment({
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_TENANT_API_KEY: 'tenant',
    prognosis_username: 'ehr-user',
    prognosis_password: 'ehr-pass',
    CARE1960_API_KEY: 'retired',
    CARE1960_BEARER_TOKEN: 'retired',
    PROGNOCIS_USERNAME: 'retired',
    PROGNOCIS_PASSWORD: 'retired',
    CLINICAL_WRITE_ACK: WRITE_ACKNOWLEDGEMENT
  }), {
    care1960ApiKey: 'anon',
    care1960BearerToken: 'tenant',
    prognocisUsername: 'ehr-user',
    prognocisPassword: 'ehr-pass',
    writeAck: WRITE_ACKNOWLEDGEMENT
  });
});

test('draft writes require the exact operator acknowledgement', () => {
  const value = config();
  value.automation.writeEnabled = true;
  assert.throws(() => requireWriteApproval(value, ''), /CLINICAL_WRITE_ACK/);
  assert.doesNotThrow(() => requireWriteApproval(value, WRITE_ACKNOWLEDGEMENT));
});
