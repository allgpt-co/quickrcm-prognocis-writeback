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

test('retained patient ID cannot be silently ignored during matching', async () => {
  const destination = Object.create(PrognocisBrowser.prototype);
  destination.selectors = {};
  await assert.rejects(
    destination.selectPatient({
      firstName: 'Sample',
      lastName: 'Patient',
      dob: '1980-01-02',
      prognocisPatientId: 'ehr-patient-7'
    }),
    /no patient ID attribute is configured/i
  );
});
