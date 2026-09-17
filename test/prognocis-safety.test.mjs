import test from 'node:test';
import assert from 'node:assert/strict';
import { PrognocisBrowser } from '../src/integrations/prognocis-browser.mjs';

test('destination rejects different existing text before a write can start', () => {
  const destination = Object.create(PrognocisBrowser.prototype);
  assert.throws(() => destination.assertNoDifferentClinicalText({
    sections: {
      hpi: { empty: false, matches: false },
      ros: { empty: true, matches: false },
      physicalExamination: { empty: false, matches: true }
    }
  }), /refusing overwrite/i);
});

test('destination permits an exact or empty section state for idempotent resume', () => {
  const destination = Object.create(PrognocisBrowser.prototype);
  assert.doesNotThrow(() => destination.assertNoDifferentClinicalText({
    sections: {
      hpi: { empty: false, matches: true },
      ros: { empty: true, matches: false },
      physicalExamination: { empty: false, matches: true }
    }
  }));
});

test('patient search does not require a retained PrognoCIS patient ID selector', async () => {
  const destination = Object.create(PrognocisBrowser.prototype);
  destination.selectors = {};
  destination.openPatientSearch = async () => {
    throw new Error('PATIENT_NAME_DOB_SEARCH_REACHED');
  };
  await assert.rejects(
    destination.selectPatient({
      firstName: 'Sample',
      lastName: 'Patient',
      dob: '1980-01-02',
      prognocisPatientId: 'ehr-patient-7'
    }),
    /PATIENT_NAME_DOB_SEARCH_REACHED/
  );
});
