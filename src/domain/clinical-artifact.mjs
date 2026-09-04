import crypto from 'node:crypto';

const TOP_LEVEL_FIELDS = new Set([
  'version', 'source', 'status', 'jobId', 'patient', 'encounter',
  'attestation', 'sections', 'diagnoses', 'artifactHash'
]);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return result;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, label, maxLength);
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

function requireDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashInput(record) {
  return {
    version: record.version,
    source: record.source,
    status: record.status,
    jobId: record.jobId,
    patient: {
      id: record.patient.id,
      firstName: record.patient.firstName,
      lastName: record.patient.lastName,
      dob: record.patient.dob,
      prognocisPatientId: record.patient.prognocisPatientId ?? null
    },
    encounter: {
      appointmentId: record.encounter.appointmentId,
      startTime: record.encounter.startTime,
      appointmentType: record.encounter.appointmentType,
      providerName: record.encounter.providerName ?? null,
      prognocisEncounterId: record.encounter.prognocisEncounterId ?? null
    },
    attestation: {
      at: record.attestation.at,
      byId: record.attestation.byId
    },
    sections: {
      hpi: record.sections.hpi,
      ros: record.sections.ros,
      physicalExamination: record.sections.physicalExamination
    },
    diagnoses: [...record.diagnoses]
      .map((diagnosis) => ({
        system: diagnosis.system,
        code: diagnosis.code,
        description: diagnosis.description ?? '',
        reviewStatus: diagnosis.reviewStatus
      }))
      .sort((left, right) => left.code.localeCompare(right.code))
  };
}

export function clinicalArtifactHash(record) {
  return crypto.createHash('sha256').update(canonicalJson(hashInput(record))).digest('hex');
}

export function validateClinicalArtifact(value) {
  const artifact = requireObject(value, 'clinical artifact');
  requireExactFields(artifact, TOP_LEVEL_FIELDS, 'clinical artifact');
  if (artifact.version !== 2) throw new Error('Unsupported clinical artifact version');
  if (artifact.source !== 'quickrcm-quickscribe') throw new Error('Unsupported clinical artifact source');
  if (artifact.status !== 'ATTESTED') throw new Error('Only provider-approved ATTESTED notes may be exported');

  const patient = requireObject(artifact.patient, 'patient');
  requireExactFields(patient, new Set([
    'id', 'firstName', 'lastName', 'dob', 'prognocisPatientId'
  ]), 'patient');
  const encounter = requireObject(artifact.encounter, 'encounter');
  requireExactFields(encounter, new Set([
    'appointmentId', 'startTime', 'appointmentType', 'providerName', 'prognocisEncounterId'
  ]), 'encounter');
  const attestation = requireObject(artifact.attestation, 'attestation');
  requireExactFields(attestation, new Set(['at', 'byId']), 'attestation');
  const sections = requireObject(artifact.sections, 'sections');
  requireExactFields(sections, new Set(['hpi', 'ros', 'physicalExamination']), 'sections');

  if (!Array.isArray(artifact.diagnoses) || artifact.diagnoses.length < 1 || artifact.diagnoses.length > 100) {
    throw new Error('clinical artifact must contain 1 to 100 accepted ICD-10-CM diagnoses');
  }
  const diagnoses = artifact.diagnoses.map((rawDiagnosis, index) => {
    const diagnosis = requireObject(rawDiagnosis, `diagnoses[${index}]`);
    requireExactFields(diagnosis, new Set([
      'system', 'code', 'description', 'reviewStatus'
    ]), `diagnoses[${index}]`);
    if (diagnosis.system !== 'ICD10CM') {
      throw new Error(`diagnoses[${index}] must use ICD10CM; procedure codes are outside this workflow`);
    }
    if (diagnosis.reviewStatus !== 'ACCEPTED') {
      throw new Error(`diagnoses[${index}] was not explicitly accepted by a human reviewer`);
    }
    const code = requireText(diagnosis.code, `diagnoses[${index}].code`, 12).toUpperCase();
    if (!/^[A-Z][0-9][A-Z0-9](?:\.[A-Z0-9]{1,4})?$/.test(code)) {
      throw new Error(`diagnoses[${index}].code is not a valid ICD-10-CM code shape`);
    }
    return {
      system: 'ICD10CM',
      code,
      description: optionalText(diagnosis.description, `diagnoses[${index}].description`, 1_000) ?? '',
      reviewStatus: 'ACCEPTED'
    };
  }).sort((left, right) => left.code.localeCompare(right.code));
  if (new Set(diagnoses.map(({ code }) => code)).size !== diagnoses.length) {
    throw new Error('clinical artifact contains duplicate ICD-10-CM diagnoses');
  }

  const validated = {
    version: 2,
    source: 'quickrcm-quickscribe',
    status: 'ATTESTED',
    jobId: requireText(artifact.jobId, 'jobId', 100),
    patient: {
      id: requireText(patient.id, 'patient.id', 100),
      firstName: requireText(patient.firstName, 'patient.firstName', 200),
      lastName: requireText(patient.lastName, 'patient.lastName', 200),
      dob: requireDate(patient.dob, 'patient.dob'),
      prognocisPatientId: optionalText(patient.prognocisPatientId, 'patient.prognocisPatientId', 200)
    },
    encounter: {
      appointmentId: requireText(encounter.appointmentId, 'encounter.appointmentId', 100),
      startTime: requireIsoTimestamp(encounter.startTime, 'encounter.startTime'),
      appointmentType: requireText(encounter.appointmentType, 'encounter.appointmentType', 300),
      providerName: optionalText(encounter.providerName, 'encounter.providerName', 300),
      prognocisEncounterId: optionalText(encounter.prognocisEncounterId, 'encounter.prognocisEncounterId', 200)
    },
    attestation: {
      at: requireIsoTimestamp(attestation.at, 'attestation.at'),
      byId: requireText(attestation.byId, 'attestation.byId', 100)
    },
    sections: {
      hpi: requireText(sections.hpi, 'sections.hpi', 50_000),
      ros: requireText(sections.ros, 'sections.ros', 50_000),
      physicalExamination: requireText(
        sections.physicalExamination,
        'sections.physicalExamination',
        50_000
      )
    },
    diagnoses,
    artifactHash: requireText(artifact.artifactHash, 'artifactHash', 64).toLowerCase()
  };
  if (!/^[a-f0-9]{64}$/.test(validated.artifactHash)) throw new Error('artifactHash is invalid');
  if (clinicalArtifactHash(validated) !== validated.artifactHash) {
    throw new Error('Clinical artifact hash does not match its provider-approved content');
  }
  return validated;
}

export function normalizeClinicalText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function textContainsExactCode(value, code) {
  const haystack = String(value ?? '').toUpperCase();
  const needle = String(code ?? '').trim().toUpperCase();
  if (!needle) return false;
  for (let from = 0; from <= haystack.length - needle.length;) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? '' : haystack[index - 1];
    const after = index + needle.length >= haystack.length ? '' : haystack[index + needle.length];
    if (!/[A-Z0-9]/.test(before) && !/[A-Z0-9]/.test(after)) return true;
    from = index + 1;
  }
  return false;
}
