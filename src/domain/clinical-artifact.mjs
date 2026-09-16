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

const PLACEHOLDER_CLINICAL_VALUES = new Set([
  'n/a',
  'na',
  'none',
  'none documented',
  'no information available',
  'not available',
  'not documented',
  'not mentioned',
  'not sure',
  'not provided',
  'unknown'
]);

const CLINICAL_SECTION_HEADINGS = new Set([
  'hpi',
  'history of present illness',
  'ros',
  'review of systems',
  'pe',
  'physical exam',
  'physical examination'
]);

function placeholderCandidate(line) {
  let candidate = line
    .normalize('NFKC')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  const colon = candidate.indexOf(':');
  if (colon >= 0) candidate = candidate.slice(colon + 1).trim();
  return candidate.toLowerCase().replace(/[.!;:,]+$/g, '').trim();
}

export function clinicalTextIsPlaceholderOnly(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lines = value.replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*#{1,6}\s+/, '').trim())
    .filter(Boolean)
    .filter((line) => !CLINICAL_SECTION_HEADINGS.has(
      line.replace(/[*_`~:]/g, '').trim().toLowerCase()
    ));
  return lines.length > 0
    && lines.every((line) => PLACEHOLDER_CLINICAL_VALUES.has(placeholderCandidate(line)));
}

function requireClinicalText(value, label, maxLength) {
  const result = requireText(value, label, maxLength);
  if (clinicalTextIsPlaceholderOnly(result)) {
    throw new Error(`${label} contains placeholder-only text rather than provider-documented findings`);
  }
  return result;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, label, maxLength);
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new Error(`${label} must be an ISO timestamp with a timezone`);
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

function normalizeClinicalArtifact(value) {
  const artifact = requireObject(value, 'clinical artifact');
  requireExactFields(artifact, TOP_LEVEL_FIELDS, 'clinical artifact');
  if (artifact.version !== 3) throw new Error('Unsupported clinical artifact version');
  if (artifact.source !== 'care1960-scribe') throw new Error('Unsupported clinical artifact source');
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

  if (!Array.isArray(artifact.diagnoses) || artifact.diagnoses.length !== 0) {
    throw new Error('Care1960 exports contain narrative sections only; diagnoses must be empty');
  }

  const validated = {
    version: artifact.version,
    source: artifact.source,
    status: 'ATTESTED',
    jobId: requireText(artifact.jobId, 'jobId', 200),
    patient: {
      id: requireText(patient.id, 'patient.id', 200),
      firstName: requireText(patient.firstName, 'patient.firstName', 200),
      lastName: requireText(patient.lastName, 'patient.lastName', 200),
      dob: requireDate(patient.dob, 'patient.dob'),
      prognocisPatientId: requireText(patient.prognocisPatientId, 'patient.prognocisPatientId', 200)
    },
    encounter: {
      appointmentId: requireText(encounter.appointmentId, 'encounter.appointmentId', 200),
      startTime: requireIsoTimestamp(encounter.startTime, 'encounter.startTime'),
      appointmentType: requireText(encounter.appointmentType, 'encounter.appointmentType', 300),
      providerName: optionalText(encounter.providerName, 'encounter.providerName', 300),
      prognocisEncounterId: requireText(encounter.prognocisEncounterId, 'encounter.prognocisEncounterId', 200)
    },
    attestation: {
      at: requireIsoTimestamp(attestation.at, 'attestation.at'),
      byId: requireText(attestation.byId, 'attestation.byId', 100)
    },
    sections: {
      hpi: requireClinicalText(sections.hpi, 'sections.hpi', 200_000),
      ros: requireClinicalText(sections.ros, 'sections.ros', 200_000),
      physicalExamination: requireClinicalText(
        sections.physicalExamination,
        'sections.physicalExamination',
        200_000
      )
    },
    diagnoses: [],
    artifactHash: artifact.artifactHash
  };
  return validated;
}

export function buildClinicalArtifact(value) {
  const normalized = normalizeClinicalArtifact(value);
  return { ...normalized, artifactHash: clinicalArtifactHash(normalized) };
}

export function validateClinicalArtifact(value) {
  const validated = normalizeClinicalArtifact(value);
  validated.artifactHash = requireText(validated.artifactHash, 'artifactHash', 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(validated.artifactHash)) throw new Error('artifactHash is invalid');
  if (clinicalArtifactHash(validated) !== validated.artifactHash) {
    throw new Error('Clinical artifact hash does not match its provider-approved content');
  }
  return validated;
}

export function normalizeClinicalText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}
