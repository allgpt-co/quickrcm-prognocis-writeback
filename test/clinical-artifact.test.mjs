import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clinicalArtifactHash,
  textContainsExactCode,
  validateClinicalArtifact
} from '../src/domain/clinical-artifact.mjs';
import { artifact } from '../test-support/artifact.mjs';

test('accepts only the strict provider-attested clinical artifact', () => {
  const validated = validateClinicalArtifact(artifact());
  assert.equal(validated.status, 'ATTESTED');
  assert.deepEqual(Object.keys(validated.sections), ['hpi', 'ros', 'physicalExamination']);
  assert.deepEqual(validated.diagnoses.map(({ code }) => code), ['R05.9']);
});

test('rejects an unapproved note even when its hash is internally consistent', () => {
  const value = artifact({ status: 'GENERATED' });
  assert.throws(() => validateClinicalArtifact(value), /only provider-approved ATTESTED/i);
});

test('rejects raw transcript or audio data at the consumer boundary', () => {
  const value = artifact({ rawTranscript: 'not allowed' });
  assert.throws(() => validateClinicalArtifact(value), /unsupported field: rawTranscript/i);
});

test('rejects CPT, HCPCS, and non-accepted code suggestions', () => {
  const cptBase = artifact();
  cptBase.diagnoses = [{
    ...cptBase.diagnoses[0],
    system: 'CPT',
    code: '99213'
  }];
  cptBase.artifactHash = clinicalArtifactHash(cptBase);
  assert.throws(() => validateClinicalArtifact(cptBase), /must use ICD10CM/i);

  const suggested = artifact();
  suggested.diagnoses[0].reviewStatus = 'SUGGESTED';
  suggested.artifactHash = clinicalArtifactHash(suggested);
  assert.throws(() => validateClinicalArtifact(suggested), /not explicitly accepted/i);
});

test('rejects any content changed after the producer generated its hash', () => {
  const changed = artifact();
  changed.sections.hpi += ' Unattested addition.';
  assert.throws(() => validateClinicalArtifact(changed), /hash does not match/i);
});

test('canonical hash treats omitted optional EHR identifiers as null', () => {
  const value = artifact();
  delete value.patient.prognocisPatientId;
  delete value.encounter.providerName;
  delete value.encounter.prognocisEncounterId;
  value.artifactHash = clinicalArtifactHash(value);
  assert.doesNotThrow(() => validateClinicalArtifact(value));
});

test('ICD-10 read-back uses token boundaries', () => {
  assert.equal(textContainsExactCode('Diagnosis R05.9 Cough', 'R05.9'), true);
  assert.equal(textContainsExactCode('Diagnosis R05.91 Other cough', 'R05.9'), false);
});
