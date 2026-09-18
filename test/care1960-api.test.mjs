import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  Care1960ApiSource,
  artifactsFromApiResponse,
  validateCare1960SourceConfig
} from '../src/integrations/care1960-api.mjs';
import { validateClinicalArtifact } from '../src/domain/clinical-artifact.mjs';
import { runWriteback } from '../src/workflow/writeback.mjs';

const example = JSON.parse(await fs.readFile(new URL('../config/care1960-response.example.json', import.meta.url)));
const fileConfig = { input: 'response-file', responseFile: 'unused.json', orgId: example.org_id };
const record = () => structuredClone(example);
const sqlResponse = JSON.parse(await fs.readFile(
  new URL('../test-support/fixtures/care1960-0010-response.json', import.meta.url)
));

async function files(t, value = record()) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'care1960-api-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const responseFile = path.join(directory, 'response.json');
  const requestFile = path.join(directory, 'request.json');
  await fs.writeFile(responseFile, JSON.stringify(value), { mode: 0o600 });
  await fs.writeFile(requestFile, JSON.stringify({ p_prognocis_appointment_id: 'synthetic-appointment-1' }), { mode: 0o600 });
  return { directory, responseFile, requestFile };
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    instance.closeAllConnections();
    instance.close(resolve);
  }));
  return `http://127.0.0.1:${instance.address().port}/rest/v1/rpc/clinical_response`;
}

test('maps explicit API fields to a normalized three-section artifact and scopes identity by organization', () => {
  const response = record();
  response.note.hpi = `  ${response.note.hpi}  `;
  response.note.assessment = 'This must never become the physical exam.';
  const [value] = artifactsFromApiResponse(response, fileConfig);
  assert.deepEqual(validateClinicalArtifact(value), value);
  assert.equal(value.sections.hpi, example.note.hpi);
  assert.equal(value.sections.ros, example.note.ros);
  assert.equal(value.sections.physicalExamination, example.note.physical_examination);
  assert.equal(value.encounter.startTime, '2026-09-16T15:30:00.000Z');
  assert.equal(value.patient.prognocisPatientId, example.patient.prognocis_patient_id);
  assert.equal(value.encounter.prognocisEncounterId, example.appointment.prognocis_encounter_id);
  assert.equal(value.jobId, `${example.org_id}:${example.scribe_job_id}`);
  assert.deepEqual(value.diagnoses, []);
});

test('accepts omitted written_back from the server-filtered API and optional explicit false', () => {
  const value = record();
  delete value.written_back;
  assert.equal(artifactsFromApiResponse([value], fileConfig).length, 1);
  value.written_back = false;
  assert.equal(artifactsFromApiResponse([value], fileConfig).length, 1);
});

test('rejects explicitly stale or malformed written_back source states before browser work', () => {
  assert.equal(artifactsFromApiResponse(record(), fileConfig).length, 1);
  for (const writtenBack of [true, null, 0, 'false']) {
    const value = record();
    value.written_back = writtenBack;
    assert.throws(
      () => artifactsFromApiResponse(value, fileConfig),
      { code: 'CARE1960_WRITEBACK_STATE_INVALID' }
    );
  }
});

test('maps wrapped POST responses and database section names through configured JSON paths', () => {
  const value = record();
  value.note = { hpi_text: 'Documented HPI.', ros_text: 'Documented ROS.', physical_exam_text: 'Documented exam.' };
  const [artifact] = artifactsFromApiResponse({ data: [value] }, {
    ...fileConfig, recordsPath: 'data', fields: {
      hpi: 'note.hpi_text', ros: 'note.ros_text', physicalExamination: 'note.physical_exam_text'
    }
  });
  assert.deepEqual(artifact.sections, { hpi: 'Documented HPI.', ros: 'Documented ROS.', physicalExamination: 'Documented exam.' });
});

test('accepts null PrognoCIS identities and appointment type from the API', () => {
  const value = record();
  value.patient.prognocis_patient_id = null;
  value.appointment.prognocis_encounter_id = null;
  value.appointment.appointment_type = null;
  const [artifact] = artifactsFromApiResponse(value, fileConfig);
  assert.equal(artifact.patient.id, null);
  assert.equal(artifact.patient.prognocisPatientId, null);
  assert.equal(artifact.encounter.prognocisEncounterId, null);
  assert.equal(artifact.encounter.appointmentType, null);
});

test('rejects sync-only, HPI-only, unapproved, wrong-tenant, ambiguous, or identity-incomplete responses', () => {
  assert.throws(() => artifactsFromApiResponse([{ authorized_org_id: example.org_id, sync_result: 'UNCHANGED' }], fileConfig));
  const hpiOnly = record();
  delete hpiOnly.note.ros;
  delete hpiOnly.note.physical_examination;
  assert.throws(() => artifactsFromApiResponse(hpiOnly, fileConfig), { code: 'CARE1960_SECTIONS_MISSING' });
  for (const edit of [
    (value) => { value.status = 'READY_FOR_REVIEW'; },
    (value) => { value.attestation = {}; },
    (value) => { value.appointment.prognocis_appointment_id = ''; },
    (value) => { value.patient.date_of_birth = '2026-02-30'; },
    (value) => { value.appointment.starts_at = '2026-09-16T15:30:00'; },
    (value) => { value.note.ros = 'Not documented.'; }
  ]) {
    const value = record();
    edit(value);
    assert.throws(() => artifactsFromApiResponse(value, fileConfig), { code: 'CARE1960_RECORD_INVALID' });
  }
  assert.throws(() => artifactsFromApiResponse(record(), { ...fileConfig, orgId: '99999999-9999-4999-8999-999999999999' }), { code: 'CARE1960_ORG_MISMATCH' });
  assert.throws(() => artifactsFromApiResponse([record(), record()], fileConfig), { code: 'CARE1960_DUPLICATE_RECORD' });
});

test('response files are reread and changed content prevents recording verification', async (t) => {
  const { responseFile } = await files(t);
  const source = new Care1960ApiSource({ ...fileConfig, responseFile });
  let verified = false;
  const result = await runWriteback({ automation: { writeEnabled: true, maxRecordsPerRun: 1 } }, {
    source,
    destination: { process: async () => {
      const edited = record();
      edited.note.ros = 'Changed while writing.';
      await fs.writeFile(responseFile, JSON.stringify(edited));
      return { status: 'DRAFT_VERIFIED', ehrEncounterId: example.appointment.prognocis_encounter_id };
    } },
    ledger: {
      has: () => false,
      isAcknowledged: () => false,
      markVerified: async () => { verified = true; },
      markAcknowledged: async () => assert.fail('Changed source must not be acknowledged')
    },
    audit: { info: async () => {}, error: async () => {} }
  });
  assert.equal(result.failed, 1);
  assert.equal(verified, false);
});

test('POST sends configured auth/body exactly once and the captured response drives writeback', async (t) => {
  const { requestFile } = await files(t);
  const requests = [];
  const apiUrl = await server(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, method: req.method, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/care1960_mark_clinical_record_written_back')) {
        res.end(JSON.stringify([{
          scribe_job_id: example.scribe_job_id,
          clinical_export_id: '44444444-4444-4444-8444-444444444444',
          written_back: true,
          written_back_at: '2026-09-17T20:00:00Z'
        }]));
      } else {
        res.end(JSON.stringify([record()]));
      }
    });
  });
  const source = new Care1960ApiSource({
    ...fileConfig,
    input: 'http',
    requestFile,
    apiUrl,
    markWrittenBackUrl: apiUrl.replace('/clinical_response', '/care1960_mark_clinical_record_written_back'),
    timeoutMs: 1_000
  }, {
    apiKey: 'synthetic-api-key', bearerToken: 'synthetic-tenant-jwt'
  });
  let writes = 0;
  const hashes = new Set();
  const acknowledged = new Set();
  const services = {
    source,
    destination: { process: async (value) => {
      writes += 1;
      assert.equal(value.sections.physicalExamination, example.note.physical_examination);
      return { status: 'DRAFT_VERIFIED', ehrEncounterId: value.encounter.prognocisEncounterId };
    } },
    ledger: {
      has: (hash) => hashes.has(hash),
      isAcknowledged: (hash) => acknowledged.has(hash),
      markVerified: async ({ artifactHash }) => hashes.add(artifactHash),
      markAcknowledged: async ({ artifactHash }) => acknowledged.add(artifactHash)
    },
    audit: { info: async () => {}, error: async () => {} }
  };
  const config = { automation: { writeEnabled: true, maxRecordsPerRun: 1 } };
  assert.equal((await runWriteback(config, services)).verified, 1);
  assert.equal((await runWriteback(config, services)).skipped, 1);
  assert.equal(writes, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.apikey, 'synthetic-api-key');
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-tenant-jwt');
  assert.deepEqual(requests[0].body, { p_prognocis_appointment_id: 'synthetic-appointment-1' });
  assert.deepEqual(requests[1].body, {
    p_scribe_job_id: example.scribe_job_id,
    p_written_back: true
  });
});

test('mark-written-back POST uses the exact source job ID and validates the returned row', async (t) => {
  const { requestFile } = await files(t);
  const requests = [];
  const apiUrl = await server(t, (req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/care1960_mark_clinical_record_written_back')) {
        res.end(JSON.stringify([{
          scribe_job_id: example.scribe_job_id,
          clinical_export_id: '44444444-4444-4444-8444-444444444444',
          written_back: true,
          written_back_at: '2026-09-17T20:00:00.000000Z'
        }]));
      } else {
        res.end(JSON.stringify([record()]));
      }
    });
  });
  const markWrittenBackUrl = apiUrl.replace(
    '/clinical_response',
    '/care1960_mark_clinical_record_written_back'
  );
  const source = new Care1960ApiSource({
    ...fileConfig,
    input: 'http',
    requestFile,
    apiUrl,
    markWrittenBackUrl,
    timeoutMs: 1_000
  }, { apiKey: 'synthetic-api-key', bearerToken: 'synthetic-tenant-jwt' });
  const [artifact] = await source.listAttestedArtifacts(1);
  const acknowledgement = await source.markWrittenBack(artifact);
  assert.deepEqual(acknowledgement, {
    scribeJobId: example.scribe_job_id,
    clinicalExportId: '44444444-4444-4444-8444-444444444444',
    writtenBack: true,
    writtenBackAt: '2026-09-17T20:00:00.000Z'
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body, {
    p_scribe_job_id: example.scribe_job_id,
    p_written_back: true
  });
  assert.equal(requests[1].headers.apikey, 'synthetic-api-key');
  assert.equal(requests[1].headers.authorization, 'Bearer synthetic-tenant-jwt');
});

test('an ambiguous mark response fails closed and is not replayed by one source instance', async (t) => {
  const { requestFile } = await files(t);
  let markCalls = 0;
  const apiUrl = await server(t, (req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/care1960_mark_clinical_record_written_back')) {
        markCalls += 1;
        res.end(JSON.stringify([{
          scribe_job_id: '99999999-9999-4999-8999-999999999999',
          clinical_export_id: '44444444-4444-4444-8444-444444444444',
          written_back: true,
          written_back_at: '2026-09-17T20:00:00Z'
        }]));
      } else {
        res.end(JSON.stringify([record()]));
      }
    });
  });
  const source = new Care1960ApiSource({
    ...fileConfig,
    input: 'http',
    requestFile,
    apiUrl,
    markWrittenBackUrl: apiUrl.replace('/clinical_response', '/care1960_mark_clinical_record_written_back'),
    timeoutMs: 1_000
  }, { apiKey: 'synthetic-api-key', bearerToken: 'synthetic-tenant-jwt' });
  const [artifact] = await source.listAttestedArtifacts(1);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(source.markWrittenBack(artifact), {
      code: 'CARE1960_ACKNOWLEDGEMENT_INVALID'
    });
  }
  assert.equal(markCalls, 1);
});

test('HTTP failures and invalid JSON never expose response bodies or retry the upsert', async (t) => {
  const { requestFile } = await files(t);
  for (const status of [200, 401, 403, 500]) {
    let count = 0;
    const apiUrl = await server(t, (_req, res) => {
      count += 1;
      res.statusCode = status;
      res.end('SECRET_TOKEN_AND_PATIENT_CONTENT');
    });
    const source = new Care1960ApiSource({ ...fileConfig, input: 'http', requestFile, apiUrl, timeoutMs: 1_000 }, { apiKey: 'fake-key', bearerToken: 'fake-tenant-jwt' });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(source.load(), (error) => {
        assert.doesNotMatch(error.message, /SECRET|PATIENT|fake-key/);
        assert.equal(error.code, status === 200 ? 'CARE1960_JSON_INVALID' : `CARE1960_HTTP_${status}`);
        return true;
      });
    }
    assert.equal(count, 1);
  }
});

test('POST refuses redirects and times out without retrying', async (t) => {
  const { requestFile } = await files(t);
  let redirectTargetHits = 0;
  const target = await server(t, (_req, res) => { redirectTargetHits += 1; res.end('{}'); });
  const redirect = await server(t, (_req, res) => { res.writeHead(307, { Location: target }); res.end(); });
  const hanging = await server(t, () => {});
  for (const apiUrl of [redirect, hanging]) {
    const source = new Care1960ApiSource({ ...fileConfig, input: 'http', requestFile, apiUrl, timeoutMs: 50 }, { apiKey: 'fake-key', bearerToken: 'fake-tenant-jwt' });
    await assert.rejects(source.load(), { code: 'CARE1960_HTTP_UNAVAILABLE' });
  }
  assert.equal(redirectTargetHits, 0);
});

test('batch limits and returned-object mutation cannot change the captured source', async (t) => {
  const second = record();
  second.scribe_job_id = '44444444-4444-4444-8444-444444444444';
  const { responseFile } = await files(t, [record(), second]);
  const source = new Care1960ApiSource({ ...fileConfig, responseFile });
  const [first] = await source.listAttestedArtifacts(1);
  first.sections.hpi = 'Tampered value';
  await assert.rejects(source.revalidate(first), /hash does not match/);
  const clean = await source.listAttestedArtifacts(2);
  assert.equal(clean.length, 2);
  assert.equal(clean[0].sections.hpi, example.note.hpi);
});

test('source configuration rejects unsafe endpoints and unsupported field paths', () => {
  for (const apiUrl of ['http://remote.example.test/rpc', 'https://user:pass@example.test/rpc', 'https://example.test/rpc?key=secret']) {
    assert.throws(() => validateCare1960SourceConfig({ ...fileConfig, input: 'http', requestFile: 'request.json', timeoutMs: 100, apiUrl }), /apiUrl/);
  }
  for (const fields of [{ hpi: '__proto__.hpi' }, { fabricated: 'note.hpi' }, { hpi: '' }]) {
    assert.throws(() => validateCare1960SourceConfig({ ...fileConfig, fields }), /fields/);
  }
});

test('migration 0010 SQL response is accepted through HTTP with no field overrides', async (t) => {
  const { requestFile } = await files(t);
  const body = { p_scribe_job_id: sqlResponse[0].scribe_job_id, p_limit: 1 };
  await fs.writeFile(requestFile, JSON.stringify(body));
  const requests = [];
  const apiUrl = await server(t, (req, res) => {
    let content = '';
    req.on('data', (chunk) => { content += chunk; });
    req.on('end', () => {
      requests.push({ body: JSON.parse(content), headers: req.headers });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Care1960-Has-More', 'false');
      res.end(JSON.stringify(sqlResponse));
    });
  });
  const source = new Care1960ApiSource({
    input: 'http', orgId: sqlResponse[0].org_id, apiUrl, requestFile, timeoutMs: 1_000
  }, { apiKey: 'synthetic-gateway-anon-key', bearerToken: 'synthetic-tenant-jwt' });
  const [artifact] = await source.listAttestedArtifacts(1);
  assert.deepEqual(artifact.sections, {
    hpi: sqlResponse[0].note.hpi,
    ros: sqlResponse[0].note.ros,
    physicalExamination: sqlResponse[0].note.physical_examination
  });
  assert.equal(artifact.attestation.at, new Date(sqlResponse[0].attestation.attested_at).toISOString());
  assert.equal(artifact.encounter.startTime, new Date(sqlResponse[0].appointment.starts_at).toISOString());
  assert.equal(artifact.status, 'ATTESTED');
  assert.equal(sqlResponse[0].attestation.note_version, 1);
  assert.match(sqlResponse[0].attestation.note_hash, /^[a-f0-9]{64}$/);
  assert.equal(requests[0].headers.apikey, 'synthetic-gateway-anon-key');
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-tenant-jwt');
  assert.deepEqual(requests[0].body, body);
  await source.revalidate(artifact);
  assert.equal(requests.length, 1);
});

test('HTTP cursor is injected and advances only after explicit successful reconciliation', async (t) => {
  const { directory, requestFile } = await files(t);
  await fs.writeFile(requestFile, JSON.stringify({ p_limit: 1 }), { mode: 0o600 });
  const cursorFile = path.join(directory, 'cursor.json');
  const originalCursor = {
    attestedAt: '2026-09-15T10:00:00.000Z',
    scribeJobId: '11111111-1111-4111-8111-111111111111'
  };
  await fs.writeFile(cursorFile, JSON.stringify(originalCursor), { mode: 0o600 });
  const requests = [];
  const apiUrl = await server(t, (req, res) => {
    let content = '';
    req.on('data', (chunk) => { content += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(content));
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Care1960-Has-More', 'true');
      res.end(JSON.stringify(sqlResponse));
    });
  });
  const source = new Care1960ApiSource({
    input: 'http', orgId: sqlResponse[0].org_id, apiUrl, requestFile, cursorFile, timeoutMs: 1_000
  }, { apiKey: 'synthetic-key', bearerToken: 'synthetic-tenant-jwt' });
  const [artifact] = await source.listAttestedArtifacts(1);
  assert.deepEqual(requests[0], {
    p_limit: 1,
    p_after_attested_at: originalCursor.attestedAt,
    p_after_scribe_job_id: originalCursor.scribeJobId
  });
  assert.deepEqual(JSON.parse(await fs.readFile(cursorFile, 'utf8')), originalCursor);
  assert.equal(source.hasMore(), true);
  assert.equal(await source.commitCursor(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(cursorFile, 'utf8')), {
    attestedAt: artifact.attestation.at,
    scribeJobId: sqlResponse[0].scribe_job_id
  });
  assert.equal((await fs.stat(cursorFile)).mode & 0o777, 0o600);
});

test('an absent tenant JWT does not fall back to the gateway anon key', async (t) => {
  const { requestFile } = await files(t);
  let calls = 0;
  const source = new Care1960ApiSource({
    ...fileConfig, input: 'http', requestFile,
    apiUrl: 'http://127.0.0.1:54321/rest/v1/rpc/care1960_get_attested_clinical_records', timeoutMs: 100
  }, { apiKey: 'synthetic-gateway-key' }, { fetchImpl: async () => { calls += 1; } });
  await assert.rejects(source.load(), { code: 'CARE1960_AUTH_REQUIRED' });
  assert.equal(calls, 0);
});

test('migration 0010 empty-array response produces no destination calls', async (t) => {
  const { responseFile } = await files(t, []);
  const source = new Care1960ApiSource({ ...fileConfig, responseFile });
  const summary = await runWriteback({ automation: { writeEnabled: false, maxRecordsPerRun: 1 } }, {
    source,
    destination: { process: async () => assert.fail('No eligible attested records') },
    ledger: { has: () => false, markVerified: async () => assert.fail('No draft was written') },
    audit: { info: async () => {}, error: async () => {} }
  });
  assert.equal(summary.queued, 0);
  assert.equal(summary.failed, 0);
});

test('CLI validates a captured response without browser configuration or credentials', async (t) => {
  const { directory, responseFile } = await files(t);
  const configFile = path.join(directory, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({ care1960: { ...fileConfig, responseFile } }));
  const { stdout } = await promisify(execFile)(process.execPath, ['src/cli.mjs', 'validate-response', '--config', configFile]);
  assert.deepEqual(JSON.parse(stdout), { mode: 'validate-response', validated: 1, ehrWrites: 0 });
  assert.doesNotMatch(stdout, /Sample|cough|synthetic-patient/);
});

test('CLI rejects incomplete API output before connecting to the EHR and releases its lock', async (t) => {
  const { directory, responseFile } = await files(t, { sync_result: 'UNCHANGED' });
  const config = JSON.parse(await fs.readFile(new URL('../config/writeback.example.json', import.meta.url)));
  config.care1960 = { ...fileConfig, responseFile };
  config.browser.cdpEndpoint = 'http://127.0.0.1:9';
  for (const key of Object.keys(config.prognocis.selectors)) {
    config.prognocis.selectors[key] = config.prognocis.selectors[key].replace(/^TODO_.*/, '#unused');
  }
  config.runtime = {
    lockFile: path.join(directory, 'run.lock'),
    auditFile: path.join(directory, 'audit.jsonl'),
    ledgerFile: path.join(directory, 'ledger.jsonl')
  };
  const configFile = path.join(directory, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(config));
  await assert.rejects(promisify(execFile)(process.execPath, ['src/cli.mjs', 'probe', '--config', configFile]), (error) => {
    assert.match(error.stderr, /Care1960 response organization/);
    assert.doesNotMatch(error.stderr, /ECONNREFUSED|connectOverCDP/);
    return true;
  });
  await assert.rejects(fs.access(config.runtime.lockFile), { code: 'ENOENT' });
});
