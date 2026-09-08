import {
  AuthenticationRequiredError,
  clickInFrames,
  firstVisibleInFrames,
  optionalVisibleInFrames,
  readField
} from '../browser/locators.mjs';
import { buildClinicalArtifact } from '../domain/build-export-artifact.mjs';

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function canonicalStatus(value) {
  return normalize(value).toUpperCase();
}

function dateOnly(value, label) {
  const text = normalize(value);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return text;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (match) return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
  match = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const months = new Map([
      ['jan', '01'], ['january', '01'], ['feb', '02'], ['february', '02'],
      ['mar', '03'], ['march', '03'], ['apr', '04'], ['april', '04'],
      ['may', '05'], ['jun', '06'], ['june', '06'], ['jul', '07'], ['july', '07'],
      ['aug', '08'], ['august', '08'], ['sep', '09'], ['sept', '09'], ['september', '09'],
      ['oct', '10'], ['october', '10'], ['nov', '11'], ['november', '11'],
      ['dec', '12'], ['december', '12']
    ]);
    const month = months.get(match[1].toLowerCase());
    if (month) return `${match[3]}-${month}-${match[2].padStart(2, '0')}`;
  }
  throw new Error(`${label} is not an exact supported date`);
}

function isoTimestamp(value, label) {
  const parsed = new Date(normalize(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} is not an exact timestamp`);
  return parsed.toISOString();
}

async function exactText(page, selector, label) {
  const result = await firstVisibleInFrames(page, selector, label);
  return normalize(await readField(result.locator));
}

async function clinicalText(page, selector, label) {
  const result = await firstVisibleInFrames(page, selector, label);
  const value = String(await readField(result.locator) ?? '').replace(/\r\n/g, '\n').trim();
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

async function optionalText(page, selector) {
  const result = await optionalVisibleInFrames(page, selector);
  return result ? normalize(await readField(result.locator)) : null;
}

async function exactAttribute(locator, attribute, label) {
  const value = normalize(await locator.getAttribute(attribute));
  if (!value) throw new Error(`${label} is missing its configured stable identifier`);
  return value;
}

async function exactWithin(row, selector, label) {
  if (!selector) throw new Error(`No selector configured for ${label}`);
  const locator = row.locator(selector).first();
  if (!(await locator.isVisible().catch(() => false))) {
    throw new Error(`Visible element not found for ${label}`);
  }
  const value = normalize(await readField(locator));
  if (!value) throw new Error(`${label} is empty`);
  return value;
}

function namesFromFullName(value, configuredPattern) {
  const fullName = normalize(value);
  const match = fullName.match(new RegExp(configuredPattern));
  const firstName = normalize(match?.groups?.firstName ?? match?.[1]);
  const lastName = normalize(match?.groups?.lastName ?? match?.[2]);
  if (!firstName || !lastName) {
    throw new Error('QuickScribe patient name does not match patientNamePattern');
  }
  return { firstName, lastName };
}

function acceptedCodeValue(value) {
  const raw = typeof value === 'string' ? value : value?.code;
  return normalize(raw).split('::', 1)[0].toUpperCase();
}

function diagnosesFromPersistedReview(codingJob) {
  const extractedData = codingJob?.extractedData;
  const acceptedCodes = Array.isArray(extractedData?.acceptedCodes)
    ? extractedData.acceptedCodes.map(acceptedCodeValue).filter(Boolean)
    : [];
  if (acceptedCodes.length === 0) {
    throw new Error('Persisted QuickRCM coding review has no human-accepted ICD-10-CM diagnoses');
  }
  if (new Set(acceptedCodes).size !== acceptedCodes.length) {
    throw new Error('Persisted QuickRCM coding review contains duplicate accepted diagnoses');
  }

  const candidates = Array.isArray(extractedData?.agent2?.icd_codes)
    ? extractedData.agent2.icd_codes
    : [];
  const byCode = new Map();
  for (const candidate of candidates) {
    const code = normalize(candidate?.code).toUpperCase();
    if (!code) continue;
    if (byCode.has(code)) {
      throw new Error(`Persisted QuickRCM coding suggestions contain duplicate ICD-10-CM code ${code}`);
    }
    byCode.set(code, candidate);
  }

  return acceptedCodes.map((code) => {
    const candidate = byCode.get(code);
    if (!candidate) {
      throw new Error(`Human-accepted ICD-10-CM code ${code} is absent from persisted coding suggestions`);
    }
    return {
      system: 'ICD10CM',
      code,
      description: normalize(candidate.description),
      reviewStatus: 'ACCEPTED'
    };
  });
}

export class QuickScribeBrowser {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.selectors = config.selectors;
    this.targets = new Map();
  }

  jobIdFromUrl(value, { required = true } = {}) {
    if (!this.config.noteIdUrlPattern) {
      if (required) throw new Error('QuickScribe note URL identity pattern is not configured');
      return null;
    }
    const parsed = new URL(value, this.config.url);
    const match = parsed.pathname.match(new RegExp(this.config.noteIdUrlPattern));
    const jobId = normalize(match?.[1]);
    if (!jobId && required) {
      throw new Error('QuickScribe note detail URL has no stable job ID matching the configured pattern');
    }
    return jobId || null;
  }

  async targetFromRow(row) {
    const metadata = this.selectors.queuePatientName ? {
      patientName: await exactWithin(row, this.selectors.queuePatientName, 'QuickScribe queue patient name'),
      patientId: await exactWithin(row, this.selectors.queuePatientId, 'QuickScribe queue patient ID'),
      serviceDate: await exactWithin(row, this.selectors.queueServiceDate, 'QuickScribe queue service date')
    } : {};
    const attributeJobId = this.selectors.noteIdAttribute
      ? await exactAttribute(row, this.selectors.noteIdAttribute, 'QuickScribe note row')
      : null;
    let targetUrl;
    if (this.selectors.noteOpenLink) {
      const link = row.locator(this.selectors.noteOpenLink).first();
      const href = await link.getAttribute('href');
      if (!href) throw new Error('ATTESTED QuickScribe note row has no stable detail URL');
      targetUrl = new URL(href, this.page.url());
    } else {
      const previousUrl = this.page.url();
      await row.click();
      await this.page.waitForURL((url) => url.href !== previousUrl, { waitUntil: 'domcontentloaded' });
      targetUrl = new URL(this.page.url());
    }
    if (targetUrl.origin !== new URL(this.config.url).origin) {
      throw new Error('QuickScribe note detail URL changed to an unexpected origin');
    }

    const urlJobId = this.config.noteIdUrlPattern
      ? this.jobIdFromUrl(targetUrl.href)
      : null;
    if (attributeJobId && urlJobId && attributeJobId !== urlJobId) {
      throw new Error('QuickScribe note row identifier does not match its detail URL');
    }
    const jobId = attributeJobId ?? urlJobId;
    if (!jobId) throw new Error('ATTESTED QuickScribe note row has no stable job ID');
    return { jobId, url: targetUrl.href, ...metadata };
  }

  async assertAuthenticated() {
    if (this.selectors.loginMarker
      && await optionalVisibleInFrames(this.page, this.selectors.loginMarker)) {
      throw new AuthenticationRequiredError('QuickRCM/QuickScribe');
    }
    try {
      await firstVisibleInFrames(
        this.page,
        this.selectors.authenticatedMarker,
        'authenticated QuickRCM/QuickScribe page'
      );
    } catch {
      const error = new AuthenticationRequiredError('QuickRCM/QuickScribe');
      error.message = 'QuickRCM/QuickScribe is not authenticated in the persistent remote browser';
      throw error;
    }
  }

  async listAttestedTargets(limit) {
    await this.page.goto(this.config.attestedNotesUrl, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated();
    let result = await firstVisibleInFrames(this.page, this.selectors.noteRows, 'QuickScribe note rows');
    let rows = result.scope.locator(this.selectors.noteRows);
    const rowCount = await rows.count();
    const targets = [];
    for (let index = 0; index < rowCount && targets.length < limit; index += 1) {
      if (this.page.url() !== this.config.attestedNotesUrl) {
        await this.page.goto(this.config.attestedNotesUrl, { waitUntil: 'domcontentloaded' });
        await this.assertAuthenticated();
        result = await firstVisibleInFrames(this.page, this.selectors.noteRows, 'QuickScribe note rows');
        rows = result.scope.locator(this.selectors.noteRows);
        if (await rows.count() !== rowCount) {
          throw new Error('QuickScribe queue changed while stable note targets were being collected');
        }
      }
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const status = canonicalStatus(
        await row.locator(this.selectors.noteStatus).first().innerText().catch(() => '')
      );
      if (status !== 'ATTESTED') continue;
      const target = await this.targetFromRow(row);
      const { jobId } = target;
      if (targets.some((target) => target.jobId === jobId)) {
        throw new Error('QuickScribe queue contains a duplicate stable job ID');
      }
      this.targets.set(jobId, target);
      targets.push(target);
    }
    return targets;
  }

  codingJobIdFromUrl(value) {
    const parsed = new URL(value, this.config.url);
    if (this.config.diagnosisPageUrlPattern
      && !new RegExp(this.config.diagnosisPageUrlPattern).test(parsed.pathname)) {
      throw new Error('QuickScribe diagnosis page URL does not match the configured coding route');
    }
    const codingJobId = normalize(parsed.pathname.split('/').filter(Boolean).at(-1));
    if (!codingJobId) throw new Error('QuickScribe diagnosis page has no stable coding job ID');
    return codingJobId;
  }

  async readPersistedCodingReview(target) {
    if (!this.config.codingJobOperationUrl) return null;
    const codingJobId = this.codingJobIdFromUrl(this.page.url());
    const result = await this.page.evaluate(async ({ operationUrl, codingJobId: id }) => {
      const rawSession = localStorage.getItem('wasp:sessionId');
      if (!rawSession) return { error: 'QuickRCM browser session is unavailable' };
      let session;
      try {
        session = JSON.parse(rawSession);
      } catch {
        session = rawSession;
      }
      const bearer = typeof session === 'string'
        ? session
        : session?.sessionId ?? session?.token;
      if (!bearer) return { error: 'QuickRCM browser session is invalid' };

      let response;
      try {
        response = await fetch(operationUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`
          },
          body: JSON.stringify({ json: { id } })
        });
      } catch {
        return { error: 'QuickRCM persisted coding review request failed' };
      }
      if (!response.ok) {
        return { error: `QuickRCM persisted coding review returned HTTP ${response.status}` };
      }
      let body;
      try {
        body = await response.json();
      } catch {
        return { error: 'QuickRCM persisted coding review returned invalid JSON' };
      }
      return { codingJob: body?.json ?? body };
    }, { operationUrl: this.config.codingJobOperationUrl, codingJobId });
    if (result?.error) throw new Error(result.error);

    const codingJob = result?.codingJob;
    if (!codingJob || typeof codingJob !== 'object') {
      throw new Error('QuickRCM persisted coding review returned no coding job');
    }
    if (normalize(codingJob.id) !== codingJobId) {
      throw new Error('QuickRCM persisted coding job identity does not match the coding page URL');
    }
    if (normalize(codingJob.scribeJobId) !== target.jobId
      || (codingJob.scribeJob?.id && normalize(codingJob.scribeJob.id) !== target.jobId)) {
      throw new Error('QuickRCM persisted coding job does not belong to the attested Scribe job');
    }
    if (!['COMPLETED', 'PASSED'].includes(canonicalStatus(codingJob.status))) {
      throw new Error('QuickRCM persisted coding job is not complete');
    }

    const configuredAppointmentId = normalize(this.config.appointmentIdByJobId?.[target.jobId]);
    const codingAppointmentId = normalize(codingJob.appointmentId);
    if (!configuredAppointmentId || configuredAppointmentId !== codingAppointmentId) {
      throw new Error('QuickRCM persisted coding job appointment does not match the configured appointment');
    }
    if (normalize(codingJob.appointment?.id) !== codingAppointmentId) {
      throw new Error('QuickRCM persisted coding job contains inconsistent appointment identity');
    }
    if (codingJob.appointment?.organizationId
      && normalize(codingJob.appointment.organizationId) !== normalize(codingJob.organizationId)) {
      throw new Error('QuickRCM persisted coding job contains inconsistent organization identity');
    }

    const persistedPatient = codingJob.appointment?.patient;
    if (!persistedPatient
      || normalize(persistedPatient.mrn) !== normalize(target.patientId)
      || normalize(`${persistedPatient.firstName} ${persistedPatient.lastName}`) !== normalize(target.patientName)) {
      throw new Error('QuickRCM persisted coding job patient does not match the attested queue record');
    }
    const startTime = isoTimestamp(codingJob.appointment?.startTime, 'persisted appointment start time');
    return {
      codingJob: {
        appointmentId: codingAppointmentId,
        appointmentType: normalize(codingJob.appointment?.appointmentType),
        startTime
      },
      diagnoses: diagnosesFromPersistedReview(codingJob)
    };
  }

  async readDiagnoses(target, { openFromDetail = false } = {}) {
    if (openFromDetail) {
      const previousUrl = this.page.url();
      await this.page.locator(this.selectors.diagnosisOpenButton).first().click();
      await this.page.waitForURL((url) => url.href !== previousUrl, { waitUntil: 'domcontentloaded' });
      if (new URL(this.page.url()).origin !== new URL(this.config.url).origin) {
        throw new Error('QuickScribe diagnosis page changed to an unexpected origin');
      }
      if (this.config.diagnosisPageUrlPattern
        && !new RegExp(this.config.diagnosisPageUrlPattern).test(new URL(this.page.url()).pathname)) {
        throw new Error('QuickScribe diagnosis page URL does not match the configured coding route');
      }
    }
    const persisted = await this.readPersistedCodingReview(target);
    const result = await optionalVisibleInFrames(this.page, this.selectors.acceptedDiagnosisRows);
    const uiDiagnoses = [];
    if (result) {
      const rows = result.scope.locator(this.selectors.acceptedDiagnosisRows);
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        if (!(await row.isVisible().catch(() => false))) continue;
        const codeLocator = row.locator(this.selectors.diagnosisCode).first();
        const code = normalize(await readField(codeLocator).catch(() => ''));
        const description = this.selectors.diagnosisDescription
          ? normalize(await readField(row.locator(this.selectors.diagnosisDescription).first()).catch(() => ''))
          : '';
        uiDiagnoses.push({ system: 'ICD10CM', code, description, reviewStatus: 'ACCEPTED' });
      }
    }
    if (persisted && uiDiagnoses.length > 0) {
      const persistedCodes = persisted.diagnoses.map(({ code }) => code).sort();
      const uiCodes = uiDiagnoses.map(({ code }) => code.toUpperCase()).sort();
      if (JSON.stringify(persistedCodes) !== JSON.stringify(uiCodes)) {
        throw new Error('Rendered and persisted QuickRCM accepted diagnosis decisions do not match');
      }
    }
    if (persisted) return persisted;
    if (uiDiagnoses.length === 0) {
      throw new Error('ATTESTED QuickScribe note has no explicit accepted ICD-10-CM diagnoses');
    }
    return { codingJob: null, diagnoses: uiDiagnoses };
  }

  usesJoinedRenderedUi() {
    return Boolean(this.selectors.queuePatientName);
  }

  async readJoinedPatient(target) {
    const names = namesFromFullName(target.patientName, this.config.patientNamePattern);
    await this.page.goto(this.config.patientDirectoryUrl, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated();
    const search = await firstVisibleInFrames(
      this.page,
      this.selectors.patientSearchInput,
      'QuickRCM patient directory search'
    );
    await search.locator.fill(target.patientName);
    const result = await firstVisibleInFrames(
      this.page,
      this.selectors.patientRows,
      'QuickRCM patient directory rows'
    );
    const rows = result.scope.locator(this.selectors.patientRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const name = normalize(await readField(row.locator(this.selectors.patientNameCell).first()).catch(() => ''));
      if (name === normalize(target.patientName)) matches.push(row);
    }
    if (matches.length !== 1) {
      throw new Error(`QuickRCM returned ${matches.length} exact patient directory matches; expected one`);
    }
    return {
      id: target.patientId,
      ...names,
      dob: dateOnly(
        await exactWithin(matches[0], this.selectors.patientDobCell, 'QuickRCM patient DOB'),
        'patient DOB'
      ),
      prognocisPatientId: null
    };
  }

  async readJoinedAppointment(target) {
    await this.page.goto(this.config.appointmentDirectoryUrl, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated();
    if (this.selectors.appointmentAllTab) {
      await clickInFrames(
        this.page,
        this.selectors.appointmentAllTab,
        'QuickScribe all-appointments filter'
      );
    }
    if (this.selectors.appointmentSearchInput) {
      const search = await firstVisibleInFrames(
        this.page,
        this.selectors.appointmentSearchInput,
        'QuickScribe appointment search'
      );
      if (this.selectors.appointmentMrnSearchInput) {
        await search.locator.fill('');
        const mrnSearch = await firstVisibleInFrames(
          this.page,
          this.selectors.appointmentMrnSearchInput,
          'QuickScribe appointment MRN search'
        );
        await mrnSearch.locator.fill(target.patientId);
      } else {
        await search.locator.fill(target.patientName);
      }
      if (this.selectors.appointmentSearchButton) {
        await clickInFrames(
          this.page,
          this.selectors.appointmentSearchButton,
          'QuickScribe appointment search action'
        );
      }
    }
    const result = await firstVisibleInFrames(
      this.page,
      this.selectors.appointmentRows,
      'QuickScribe appointment rows'
    );
    const rows = result.scope.locator(this.selectors.appointmentRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const patientName = normalize(
        await readField(row.locator(this.selectors.appointmentPatientNameCell).first()).catch(() => '')
      );
      const patientId = normalize(
        await readField(row.locator(this.selectors.appointmentPatientIdCell).first()).catch(() => '')
      );
      if (patientName !== normalize(target.patientName) || !patientId.includes(normalize(target.patientId))) continue;
      if (this.selectors.appointmentServiceDateCell) {
        const serviceDate = dateOnly(
          await readField(row.locator(this.selectors.appointmentServiceDateCell).first()).catch(() => ''),
          'appointment service date'
        );
        if (serviceDate !== dateOnly(target.serviceDate, 'encounter service date')) continue;
      }
      matches.push(row);
    }
    if (matches.length !== 1) {
      throw new Error(`QuickScribe returned ${matches.length} exact appointment matches; expected one`);
    }
    const row = matches[0];
    const sourceType = await exactWithin(
      row,
      this.selectors.appointmentTypeCell,
      'QuickScribe appointment type'
    );
    const appointmentType = this.config.appointmentTypeMap?.[sourceType] ?? sourceType;
    let appointmentId = this.config.appointmentIdByJobId?.[target.jobId];
    if (!appointmentId && this.selectors.appointmentIdAttribute) {
      appointmentId = await exactAttribute(row, this.selectors.appointmentIdAttribute, 'QuickScribe appointment row');
    }
    appointmentId = normalize(appointmentId);
    if (!appointmentId) {
      throw new Error('QuickScribe exact appointment has no configured stable appointment ID');
    }
    return {
      appointmentId,
      startTime: `${dateOnly(target.serviceDate, 'encounter service date')}T12:00:00.000Z`,
      appointmentType,
      providerName: this.selectors.appointmentProviderCell
        ? await exactWithin(row, this.selectors.appointmentProviderCell, 'QuickScribe appointment provider')
        : null,
      prognocisEncounterId: null
    };
  }

  async extractTarget(target) {
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated();
    const root = await firstVisibleInFrames(
      this.page,
      this.selectors.noteDetailRoot,
      'QuickScribe note detail'
    );
    const attributeJobId = this.selectors.noteIdAttribute
      ? await exactAttribute(root.locator, this.selectors.noteIdAttribute, 'QuickScribe note detail')
      : null;
    const urlJobId = this.config.noteIdUrlPattern ? this.jobIdFromUrl(this.page.url()) : null;
    if (attributeJobId && urlJobId && attributeJobId !== urlJobId) {
      throw new Error('QuickScribe note detail identifier does not match its URL');
    }
    const jobId = attributeJobId ?? urlJobId;
    if (!jobId) throw new Error('QuickScribe note detail has no stable job ID');
    if (jobId !== target.jobId) throw new Error('QuickScribe note identity changed between queue and detail page');
    const status = canonicalStatus(
      await exactText(this.page, this.selectors.detailStatus, 'QuickScribe note status')
    );
    if (status !== 'ATTESTED') throw new Error('QuickScribe note is no longer ATTESTED');

    const finalNote = await clinicalText(this.page, this.selectors.finalNote, 'provider-approved QuickScribe note');
    const attestationText = await exactText(this.page, this.selectors.attestationAt, 'provider attestation time');
    const attestationBy = await exactText(this.page, this.selectors.attestationBy, 'provider attestation actor');
    let patient;
    let encounter;
    if (this.usesJoinedRenderedUi()) {
      patient = await this.readJoinedPatient(target);
      encounter = await this.readJoinedAppointment(target);
      await this.page.goto(target.url, { waitUntil: 'domcontentloaded' });
      await this.assertAuthenticated();
    } else {
      const serviceDateText = await exactText(this.page, this.selectors.serviceDate, 'encounter service date');
      patient = {
        id: await exactText(this.page, this.selectors.patientId, 'QuickRCM patient ID'),
        firstName: await exactText(this.page, this.selectors.patientFirstName, 'patient first name'),
        lastName: await exactText(this.page, this.selectors.patientLastName, 'patient last name'),
        dob: dateOnly(await exactText(this.page, this.selectors.patientDob, 'patient DOB'), 'patient DOB'),
        prognocisPatientId: await optionalText(this.page, this.selectors.prognocisPatientId)
      };
      encounter = {
        appointmentId: await exactText(this.page, this.selectors.appointmentId, 'QuickRCM appointment ID'),
        startTime: `${dateOnly(serviceDateText, 'encounter service date')}T12:00:00.000Z`,
        appointmentType: await exactText(this.page, this.selectors.appointmentType, 'appointment type'),
        providerName: await optionalText(this.page, this.selectors.providerName),
        prognocisEncounterId: await optionalText(this.page, this.selectors.prognocisEncounterId)
      };
    }

    const diagnosisReview = await this.readDiagnoses(target, {
      openFromDetail: this.usesJoinedRenderedUi()
    });
    if (diagnosisReview.codingJob) {
      if (encounter.appointmentId !== diagnosisReview.codingJob.appointmentId) {
        throw new Error('Rendered and persisted QuickRCM appointment identities do not match');
      }
      const persistedType = this.config.appointmentTypeMap?.[
        diagnosisReview.codingJob.appointmentType
      ] ?? diagnosisReview.codingJob.appointmentType;
      if (persistedType && normalize(persistedType) !== normalize(encounter.appointmentType)) {
        throw new Error('Rendered and persisted QuickRCM appointment types do not match');
      }
      encounter = {
        ...encounter,
        startTime: diagnosisReview.codingJob.startTime
      };
    }

    return buildClinicalArtifact({
      status,
      jobId,
      patient,
      encounter,
      attestation: {
        at: isoTimestamp(attestationText, 'provider attestation time'),
        byId: attestationBy
      },
      finalNote,
      diagnoses: diagnosisReview.diagnoses
    });
  }

  async listAttestedArtifacts(limit) {
    const targets = await this.listAttestedTargets(limit);
    const artifacts = [];
    for (const target of targets) artifacts.push(await this.extractTarget(target));
    return artifacts;
  }

  async revalidate(artifact) {
    const target = this.targets.get(artifact.jobId);
    if (!target) throw new Error('QuickScribe target is unavailable for revalidation');
    const current = await this.extractTarget(target);
    if (current.status !== 'ATTESTED' || current.artifactHash !== artifact.artifactHash) {
      const error = new Error('QuickScribe attested note changed during write-back');
      error.code = 'SOURCE_CHANGED';
      throw error;
    }
    return current;
  }
}
