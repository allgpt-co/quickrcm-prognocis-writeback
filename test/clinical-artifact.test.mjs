import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clinicalArtifactHash,
  validateClinicalArtifact
} from '../src/domain/clinical-artifact.mjs';
import { artifact } from '../test-support/artifact.mjs';

test('accepts only the strict provider-attested clinical artifact', () => {
  const validated = validateClinicalArtifact(artifact());
  assert.equal(validated.status, 'ATTESTED');
  assert.deepEqual(Object.keys(validated.sections), ['hpi', 'ros', 'physicalExamination']);
  assert.deepEqual(validated.diagnoses, []);
});

test('rejects an unapproved note even when its hash is internally consistent', () => {
  const value = artifact({ status: 'GENERATED' });
  assert.throws(() => validateClinicalArtifact(value), /only provider-approved ATTESTED/i);
});

test('rejects raw transcript or audio data at the consumer boundary', () => {
  const value = artifact({ rawTranscript: 'not allowed' });
  assert.throws(() => validateClinicalArtifact(value), /unsupported field: rawTranscript/i);
});

test('rejects diagnosis codes and retired source artifacts', () => {
  const value = artifact({ diagnoses: [{ system: 'ICD10CM', code: 'R05.9' }] });
  assert.throws(() => validateClinicalArtifact(value), /diagnoses must be empty/);
  assert.throws(() => validateClinicalArtifact(artifact({ version: 2 })), /Unsupported/);
  assert.throws(() => validateClinicalArtifact(artifact({ source: 'retired-browser-source' })), /Unsupported/);
});

test('rejects any content changed after the producer generated its hash', () => {
  const changed = artifact();
  changed.sections.hpi += ' Unattested addition.';
  assert.throws(() => validateClinicalArtifact(changed), /hash does not match/i);
});

test('preserves attested placeholder text and still rejects subsequent content changes', () => {
  const base = artifact();
  const value = artifact({
    sections: {
      ...base.sections,
      ros: '- Constitutional: Not documented.\n- Respiratory: Not documented.'
    }
  });
  assert.equal(validateClinicalArtifact(value).sections.ros, value.sections.ros);
  value.sections.ros = 'Normal findings invented after attestation.';
  assert.throws(() => validateClinicalArtifact(value), /hash does not match/i);
});

test('canonical hash treats an omitted optional provider as null', () => {
  const value = artifact();
  delete value.encounter.providerName;
  value.artifactHash = clinicalArtifactHash(value);
  assert.doesNotThrow(() => validateClinicalArtifact(value));
});
