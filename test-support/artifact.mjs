import { clinicalArtifactHash } from '../src/domain/clinical-artifact.mjs';

export function artifact(overrides = {}) {
  const base = {
    version: 2,
    source: 'quickrcm-quickscribe',
    status: 'ATTESTED',
    jobId: 'scribe-job-1',
    patient: {
      id: 'quickrcm-patient-1',
      firstName: 'Sample',
      lastName: 'Patient',
      dob: '1980-01-02',
      prognocisPatientId: 'ehr-patient-7'
    },
    encounter: {
      appointmentId: 'quickrcm-appointment-1',
      startTime: '2026-09-04T15:30:00.000Z',
      appointmentType: 'Follow Up',
      providerName: 'Dr Example',
      prognocisEncounterId: 'ehr-encounter-9'
    },
    attestation: {
      at: '2026-09-04T17:00:00.000Z',
      byId: 'provider-1'
    },
    sections: {
      hpi: 'Patient reports an improving cough.',
      ros: 'Respiratory: cough. Constitutional: denies fever or chills.',
      physicalExamination: 'Mouth and throat normal. Lungs clear to auscultation.'
    },
    diagnoses: [{
      system: 'ICD10CM',
      code: 'R05.9',
      description: 'Cough, unspecified',
      reviewStatus: 'ACCEPTED'
    }]
  };
  const merged = { ...base, ...overrides };
  return { ...merged, artifactHash: clinicalArtifactHash(merged) };
}
