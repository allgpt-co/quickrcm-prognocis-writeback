import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClinicalArtifact,
  parseExplicitClinicalSections
} from '../src/domain/build-export-artifact.mjs';
import { artifact } from '../test-support/artifact.mjs';

test('maps only explicit HPI, ROS, and Physical Examination headings', () => {
  assert.deepEqual(parseExplicitClinicalSections([
    '## HPI',
    'Cough is improving.',
    '## ROS',
    'Respiratory: cough. Denies fever.',
    '## Physical Examination',
    'Lungs clear.',
    '## Assessment',
    'This text is deliberately not added to Physical Examination.'
  ].join('\n')), {
    hpi: 'Cough is improving.',
    ros: 'Respiratory: cough. Denies fever.',
    physicalExamination: 'Lungs clear.'
  });
});

test('refuses semantic guessing from a generic Subjective/Objective SOAP note', () => {
  assert.throws(() => parseExplicitClinicalSections(
    'Subjective: cough\nObjective: lungs clear\nAssessment: viral illness\nPlan: fluids'
  ), /no explicit hpi/i);
});

test('builds and hashes the v2 consumer artifact from an attested source', () => {
  const expected = artifact();
  const built = buildClinicalArtifact({
    status: expected.status,
    jobId: expected.jobId,
    patient: expected.patient,
    encounter: expected.encounter,
    attestation: expected.attestation,
    sections: expected.sections,
    diagnoses: expected.diagnoses
  });
  assert.equal(built.artifactHash, expected.artifactHash);
  assert.equal(built.artifactHash, '3bd3f5f7cb176fc0d8dd4d220e714a1fa702df5fa5f9a57a55c7930842eae7af');
});
