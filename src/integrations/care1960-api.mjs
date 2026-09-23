import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildClinicalArtifact,
  validateClinicalArtifact
} from '../domain/clinical-artifact.mjs';

const MAX_BYTES = 10 * 1024 * 1024;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isPath = (value) => typeof value === 'string'
  && value.split('.').every((part) => /^[A-Za-z_][A-Za-z0-9_]*$|^\d+$/.test(part)
    && !['__proto__', 'constructor', 'prototype'].includes(part));

// Matches migration 0010's care1960_get_attested_clinical_records response.
// The appointment-upsert RPC is an inbound sync API, not this clinical source.
export const DEFAULT_RESPONSE_FIELDS = Object.freeze({
  orgId: 'org_id',
  jobId: 'scribe_job_id',
  status: 'status',
  writtenBack: 'written_back',
  patientId: 'patient.prognocis_patient_id',
  firstName: 'patient.first_name',
  lastName: 'patient.last_name',
  dob: 'patient.date_of_birth',
  appointmentId: 'appointment.prognocis_appointment_id',
  encounterId: 'appointment.prognocis_encounter_id',
  startTime: 'appointment.starts_at',
  appointmentType: 'appointment.appointment_type',
  providerName: 'appointment.provider_name',
  attestedAt: 'attestation.attested_at',
  attestedBy: 'attestation.attested_by',
  hpi: 'note.hpi',
  ros: 'note.ros',
  physicalExamination: 'note.physical_examination'
});

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function atPath(value, path) {
  if (!path) return value;
  for (const key of path.split('.')) {
    if ((!isObject(value) && !Array.isArray(value)) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

export function validateCare1960SourceConfig(config) {
  if (!isObject(config)) throw new Error('care1960 API source configuration is required');
  if (!['response-file', 'http'].includes(config.input)) {
    throw new Error('care1960.input must be response-file or http');
  }
  if (!isText(config.orgId) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(config.orgId)) {
    throw new Error('care1960.orgId must be the expected organization UUID');
  }
  if (config.recordsPath !== undefined && config.recordsPath !== '' && !isPath(config.recordsPath)) {
    throw new Error('care1960.recordsPath must be an empty string or a dot-separated JSON path');
  }
  if (config.fields !== undefined) {
    if (!isObject(config.fields)) throw new Error('care1960.fields must be a field-to-JSON-path object');
    for (const [name, path] of Object.entries(config.fields)) {
      if (!Object.hasOwn(DEFAULT_RESPONSE_FIELDS, name) || !isPath(path)) {
        throw new Error('care1960.fields contains an unsupported field or invalid JSON path');
      }
    }
  }
  if (config.input === 'response-file') {
    if (!isText(config.responseFile)) throw new Error('care1960.responseFile is required');
  } else {
    let url;
    try { url = new URL(config.apiUrl); } catch { throw new Error('care1960.apiUrl must be a valid URL'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      || url.username || url.password || url.hash || url.search || /TODO_|YOUR-/i.test(url.href)) {
      throw new Error('care1960.apiUrl must use HTTPS (or loopback HTTP) without credentials, query, or fragment');
    }
    if (!isText(config.requestFile)) throw new Error('care1960.requestFile is required for the POST body');
    if (config.cursorFile !== undefined && !isText(config.cursorFile)) {
      throw new Error('care1960.cursorFile must be a private JSON file path');
    }
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000) {
      throw new Error('care1960.timeoutMs must be an integer from 1 to 60000');
    }
    for (const field of ['markWrittenBackUrl', 'setRetryFailedUrl']) {
      if (config[field] === undefined) continue;
      let acknowledgementUrl;
      try { acknowledgementUrl = new URL(config[field]); } catch {
        throw new Error(`care1960.${field} must be a valid URL`);
      }
      const acknowledgementLocal = ['localhost', '127.0.0.1', '[::1]'].includes(acknowledgementUrl.hostname);
      if ((acknowledgementUrl.protocol !== 'https:'
          && !(acknowledgementLocal && acknowledgementUrl.protocol === 'http:'))
        || acknowledgementUrl.username || acknowledgementUrl.password
        || acknowledgementUrl.hash || acknowledgementUrl.search
        || /TODO_|YOUR-/i.test(acknowledgementUrl.href)) {
        throw new Error(`care1960.${field} must use HTTPS (or loopback HTTP) without credentials, query, or fragment`);
      }
      if (acknowledgementUrl.origin !== url.origin) {
        throw new Error(`care1960.${field} must use the same origin as care1960.apiUrl`);
      }
    }
  }
  return config;
}

export function artifactsFromApiResponse(response, config) {
  const fields = { ...DEFAULT_RESPONSE_FIELDS, ...config.fields };
  const data = atPath(response, config.recordsPath ?? '');
  const records = Array.isArray(data) ? data : [data];
  if (records.length > 100 || records.some((record) => !isObject(record))) {
    throw failure('CARE1960_RESPONSE_INVALID', 'Care1960 response must contain an object or up to 100 records');
  }
  const seen = new Set();
  return records.map((record) => {
    const read = (name) => atPath(record, fields[name]);
    if (!isText(read('orgId')) || read('orgId').toLowerCase() !== config.orgId.toLowerCase()) {
      throw failure('CARE1960_ORG_MISMATCH', 'Care1960 response organization does not match configuration');
    }
    if (!isText(read('jobId')) || read('jobId').length > 100) {
      throw failure('CARE1960_RESPONSE_INVALID', 'Care1960 response is missing a stable clinical job ID');
    }
    // The fetch RPC filters written_back=false server-side and omits the field.
    // Accept omission; reject an explicitly stale or malformed state if supplied.
    const writtenBack = read('writtenBack');
    if (writtenBack !== undefined && writtenBack !== false) {
      throw failure(
        'CARE1960_WRITEBACK_STATE_INVALID',
        'Care1960 response written_back must be false when supplied'
      );
    }
    // Namespace job identity by tenant. No organization is inferred from names.
    const jobId = `${config.orgId.toLowerCase()}:${read('jobId').trim()}`;
    if (seen.has(jobId)) throw failure('CARE1960_DUPLICATE_RECORD', 'Care1960 response contains a duplicate clinical job');
    seen.add(jobId);
    if (['hpi', 'ros', 'physicalExamination'].some((name) => !isText(read(name)))) {
      throw failure('CARE1960_SECTIONS_MISSING',
        'Care1960 response must include HPI, ROS, and Physical Examination; sync metadata or HPI-only output cannot be written');
    }
    try {
      return buildClinicalArtifact({
        version: 3,
        source: 'care1960-scribe',
        jobId,
        status: read('status'),
        patient: {
          id: read('patientId'),
          prognocisPatientId: read('patientId'),
          firstName: read('firstName'),
          lastName: read('lastName'),
          dob: read('dob')
        },
        encounter: {
          appointmentId: read('appointmentId'),
          prognocisEncounterId: read('encounterId'),
          startTime: read('startTime'),
          appointmentType: read('appointmentType'),
          providerName: read('providerName')
        },
        attestation: { at: read('attestedAt'), byId: read('attestedBy') },
        sections: { hpi: read('hpi'), ros: read('ros'), physicalExamination: read('physicalExamination') },
        diagnoses: []
      });
    } catch {
      // Validation may process PHI; expose only a controlled error at the API boundary.
      throw failure('CARE1960_RECORD_INVALID',
        'Care1960 record requires ATTESTED status, attestation, patient name/DOB, appointment date, and substantive clinical sections');
    }
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch {
    throw failure('CARE1960_JSON_INVALID', 'Care1960 input is not valid JSON');
  }
}

async function readJsonFile(file) {
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const { size } = await handle.stat();
    if (size > MAX_BYTES) throw new Error('too large');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('too large');
    return parseJson(buffer.subarray(0, length).toString('utf8'));
  } catch (error) {
    if (error.code === 'CARE1960_JSON_INVALID') throw error;
    throw failure('CARE1960_FILE_UNAVAILABLE', 'Care1960 input file cannot be read or exceeds 10 MiB');
  } finally {
    await handle?.close();
  }
}

async function readCursorFile(file) {
  if (!file) return null;
  let value;
  try {
    value = parseJson(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('CARE1960_')) throw error;
    throw failure('CARE1960_CURSOR_INVALID', 'Care1960 cursor cannot be read');
  }
  if (!isObject(value) || Object.keys(value).sort().join(',') !== 'attestedAt,scribeJobId'
    || !isText(value.attestedAt) || Number.isNaN(new Date(value.attestedAt).valueOf())
    || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.attestedAt) || !isText(value.scribeJobId)
    || value.scribeJobId.length > 100) {
    throw failure('CARE1960_CURSOR_INVALID', 'Care1960 cursor is malformed');
  }
  return value;
}

async function writeCursorFile(file, cursor) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(cursor)}\n`, { mode: 0o600, flag: 'wx' });
    const handle = await fs.open(temporary, 'r');
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
    const directory = await fs.open(path.dirname(file), 'r');
    await directory.sync();
    await directory.close();
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function readResponseJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw failure('CARE1960_RESPONSE_TOO_LARGE', 'Care1960 response exceeds 10 MiB');
    chunks.push(chunk);
  }
  return parseJson(Buffer.concat(chunks).toString('utf8'));
}

export class Care1960ApiSource {
  #snapshot;
  #loadPromise;
  #selected = [];
  #hasMore = false;
  #acknowledgementPromises = new Map();
  #retryFailedPromises = new Map();

  constructor(config, { apiKey = '', bearerToken = '' } = {}, { fetchImpl = fetch } = {}) {
    this.config = structuredClone(validateCare1960SourceConfig(config));
    this.apiKey = apiKey;
    this.bearerToken = bearerToken;
    this.fetch = fetchImpl;
  }

  async readInput() {
    if (this.config.input === 'response-file') return readJsonFile(this.config.responseFile);
    if (!isText(this.apiKey) || !isText(this.bearerToken)) {
      throw failure('CARE1960_AUTH_REQUIRED', 'Care1960 gateway API key and separate tenant bearer token are required');
    }
    const body = await readJsonFile(this.config.requestFile);
    if (!isObject(body)) throw failure('CARE1960_REQUEST_INVALID', 'Care1960 POST body must be a JSON object');
    const cursor = await readCursorFile(this.config.cursorFile);
    if (cursor) {
      if (Object.hasOwn(body, 'p_after_attested_at') || Object.hasOwn(body, 'p_after_scribe_job_id')) {
        throw failure('CARE1960_REQUEST_INVALID', 'Care1960 request file must not override the durable cursor');
      }
      body.p_after_attested_at = cursor.attestedAt;
      body.p_after_scribe_job_id = cursor.scribeJobId;
    }
    let response;
    try {
      response = await this.fetch(this.config.apiUrl, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          apikey: this.apiKey,
          Authorization: `Bearer ${this.bearerToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch {
      throw failure('CARE1960_HTTP_UNAVAILABLE', 'Care1960 POST failed; no automatic retry was attempted');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure(`CARE1960_HTTP_${response.status}`, `Care1960 POST returned HTTP ${response.status}`);
    }
    this.#hasMore = String(response.headers.get('X-Care1960-Has-More') ?? '').toLowerCase() === 'true';
    try { return await readResponseJson(response); } catch (error) {
      if (error.code?.startsWith('CARE1960_')) throw error;
      throw failure('CARE1960_RESPONSE_INVALID', 'Care1960 response could not be read');
    }
  }

  async load() {
    // One POST per source instance. Never repeat it during EHR checks,
    // even when a response is malformed or the network result is uncertain.
    this.#loadPromise ??= this.readInput().then((response) => {
      this.#snapshot = artifactsFromApiResponse(response, this.config);
    });
    await this.#loadPromise;
  }

  async listAttestedArtifacts(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Care1960 limit must be from 1 to 100');
    await this.load();
    this.#selected = this.#snapshot.slice(0, limit);
    return structuredClone(this.#selected);
  }

  async commitCursor() {
    if (this.config.input !== 'http' || !this.config.cursorFile || this.#selected.length === 0) return false;
    const selected = [...this.#selected].sort((left, right) => {
      const byTime = left.attestation.at.localeCompare(right.attestation.at);
      return byTime || left.jobId.localeCompare(right.jobId);
    });
    const last = selected.at(-1);
    const prefix = `${this.config.orgId.toLowerCase()}:`;
    if (!last.jobId.startsWith(prefix)) {
      throw failure('CARE1960_CURSOR_INVALID', 'Care1960 cursor job identity is invalid');
    }
    await writeCursorFile(this.config.cursorFile, {
      attestedAt: last.attestation.at,
      scribeJobId: last.jobId.slice(prefix.length)
    });
    return true;
  }

  hasMore() { return this.#hasMore; }

  async revalidate(artifact) {
    await this.load();
    validateClinicalArtifact(artifact);
    const records = this.config.input === 'response-file'
      ? artifactsFromApiResponse(await readJsonFile(this.config.responseFile), this.config)
      : this.#snapshot;
    const current = records.find((candidate) => candidate.jobId === artifact.jobId);
    if (!current || current.artifactHash !== artifact.artifactHash) {
      throw failure('CARE1960_SOURCE_CHANGED', 'Care1960 response content changed or the clinical job disappeared');
    }
    // HTTP mode verifies the captured response, not current upstream state.
    // File mode also rereads the response file before/after the EHR operation.
    return true;
  }

  async markWrittenBack(artifact) {
    await this.load();
    validateClinicalArtifact(artifact);
    if (this.config.input !== 'http' || !isText(this.config.markWrittenBackUrl)) {
      throw failure(
        'CARE1960_ACKNOWLEDGEMENT_CONFIG_INVALID',
        'Care1960 mark-written-back endpoint is required for HTTP write mode'
      );
    }
    if (!isText(this.apiKey) || !isText(this.bearerToken)) {
      throw failure('CARE1960_AUTH_REQUIRED', 'Care1960 gateway API key and separate tenant bearer token are required');
    }
    const prefix = `${this.config.orgId.toLowerCase()}:`;
    if (!artifact.jobId.startsWith(prefix)) {
      throw failure('CARE1960_ACKNOWLEDGEMENT_INVALID', 'Care1960 acknowledgement job identity is invalid');
    }
    const scribeJobId = artifact.jobId.slice(prefix.length);
    if (!isText(scribeJobId) || scribeJobId.length > 100) {
      throw failure('CARE1960_ACKNOWLEDGEMENT_INVALID', 'Care1960 acknowledgement job identity is invalid');
    }
    if (this.#acknowledgementPromises.has(artifact.artifactHash)) {
      return this.#acknowledgementPromises.get(artifact.artifactHash);
    }
    const request = this.#postMarkWrittenBack(scribeJobId);
    this.#acknowledgementPromises.set(artifact.artifactHash, request);
    return request;
  }

  async markRetryFailed(artifact) {
    await this.revalidate(artifact);
    if (this.config.input !== 'http' || !isText(this.config.setRetryFailedUrl)) {
      throw failure('CARE1960_RETRY_FAILED_CONFIG_INVALID', 'Care1960 retry-failed endpoint is required');
    }
    if (!isText(this.apiKey) || !isText(this.bearerToken)) {
      throw failure('CARE1960_AUTH_REQUIRED', 'Care1960 gateway API key and separate tenant bearer token are required');
    }
    const prefix = `${this.config.orgId.toLowerCase()}:`;
    const scribeJobId = artifact.jobId.slice(prefix.length);
    if (!artifact.jobId.startsWith(prefix)
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(scribeJobId)) {
      throw failure('CARE1960_RETRY_FAILED_INVALID', 'Care1960 retry-failed job identity is invalid');
    }
    if (!this.#retryFailedPromises.has(artifact.artifactHash)) {
      this.#retryFailedPromises.set(artifact.artifactHash, this.#postRetryFailed(scribeJobId));
    }
    return this.#retryFailedPromises.get(artifact.artifactHash);
  }

  async #postRetryFailed(scribeJobId) {
    let response;
    try {
      response = await this.fetch(this.config.setRetryFailedUrl, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          apikey: this.apiKey,
          Authorization: `Bearer ${this.bearerToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ p_scribe_job_id: scribeJobId, p_retry_failed: true })
      });
    } catch {
      throw failure('CARE1960_RETRY_FAILED_UNAVAILABLE', 'Care1960 retry-failed POST failed; no automatic retry was attempted');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure(`CARE1960_RETRY_FAILED_HTTP_${response.status}`, `Care1960 retry-failed POST returned HTTP ${response.status}`);
    }
    let payload;
    try { payload = await readResponseJson(response); } catch {
      throw failure('CARE1960_RETRY_FAILED_INVALID', 'Care1960 retry-failed response could not be validated');
    }
    const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
    if (!isObject(row) || row.scribe_job_id !== scribeJobId || row.retry_failed !== true
      || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(row.clinical_export_id ?? ''))) {
      throw failure('CARE1960_RETRY_FAILED_INVALID', 'Care1960 retry-failed response did not prove the exact row was flagged');
    }
    return { scribeJobId, clinicalExportId: row.clinical_export_id, retryFailed: true };
  }

  async #postMarkWrittenBack(scribeJobId) {
    let response;
    try {
      response = await this.fetch(this.config.markWrittenBackUrl, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          apikey: this.apiKey,
          Authorization: `Bearer ${this.bearerToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          p_scribe_job_id: scribeJobId,
          p_written_back: true
        })
      });
    } catch {
      throw failure(
        'CARE1960_ACKNOWLEDGEMENT_UNAVAILABLE',
        'Care1960 mark-written-back POST failed; no automatic retry was attempted'
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure(
        `CARE1960_ACKNOWLEDGEMENT_HTTP_${response.status}`,
        `Care1960 mark-written-back POST returned HTTP ${response.status}`
      );
    }
    let payload;
    try {
      payload = await readResponseJson(response);
    } catch {
      throw failure(
        'CARE1960_ACKNOWLEDGEMENT_INVALID',
        'Care1960 mark-written-back response could not be validated'
      );
    }
    const row = Array.isArray(payload) && payload.length === 1 ? payload[0] : null;
    const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
    if (!isObject(row) || row.scribe_job_id !== scribeJobId
      || !uuid.test(String(row.clinical_export_id ?? ''))
      || row.written_back !== true
      || !isText(row.written_back_at)
      || Number.isNaN(new Date(row.written_back_at).valueOf())
      || !/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.written_back_at)) {
      throw failure(
        'CARE1960_ACKNOWLEDGEMENT_INVALID',
        'Care1960 mark-written-back response did not prove the exact row was acknowledged'
      );
    }
    return {
      scribeJobId,
      clinicalExportId: row.clinical_export_id,
      writtenBack: true,
      writtenBackAt: new Date(row.written_back_at).toISOString()
    };
  }
}
