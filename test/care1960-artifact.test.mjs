import test from 'node:test';
import assert from 'node:assert/strict';
import { validateClinicalArtifact } from '../src/domain/clinical-artifact.mjs';
import { care1960Artifact } from '../test-support/care1960-artifact.mjs';

test('Care1960 requires all three attested narrative sections without codes', () => {
  const value = care1960Artifact();
  assert.deepEqual(validateClinicalArtifact(value), value);
  for (const section of ['hpi', 'ros', 'physicalExamination']) {
    for (const missing of ['', 'Not documented']) {
      assert.throws(() => validateClinicalArtifact(care1960Artifact({
        sections: { ...value.sections, [section]: missing }
      })), new RegExp(`sections.${section}`));
    }
  }
  assert.throws(() => validateClinicalArtifact(care1960Artifact({ status: 'READY_FOR_REVIEW' })), /ATTESTED/);
});

test('Care1960 accepts optional PrognoCIS identities and appointment type', () => {
  const value = care1960Artifact();
  const validated = validateClinicalArtifact(care1960Artifact({
    patient: { ...value.patient, id: null, prognocisPatientId: null },
    encounter: {
      ...value.encounter,
      appointmentType: null,
      prognocisEncounterId: null
    }
  }));
  assert.equal(validated.patient.id, null);
  assert.equal(validated.patient.prognocisPatientId, null);
  assert.equal(validated.encounter.appointmentType, null);
  assert.equal(validated.encounter.prognocisEncounterId, null);
});

test('Care1960 never imports codes or silently accepts a changed section', () => {
  assert.throws(() => validateClinicalArtifact(care1960Artifact({
    diagnoses: [{ system: 'ICD10CM', code: 'R05.9', reviewStatus: 'ACCEPTED' }]
  })), /diagnoses must be empty/);
  const value = care1960Artifact();
  value.sections.ros = 'Changed after approval';
  assert.throws(() => validateClinicalArtifact(value), /hash does not match/);
});

test('Care1960 narrative limits match the source note columns without truncation', () => {
  const value = care1960Artifact();
  const longHpi = 'Documented finding. '.repeat(5_000).trim();
  const validated = validateClinicalArtifact(care1960Artifact({
    sections: { ...value.sections, hpi: longHpi }
  }));
  assert.equal(validated.sections.hpi, longHpi.trim());
});
