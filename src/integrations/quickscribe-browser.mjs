import { AuthenticationRequiredError, firstVisibleInFrames, optionalVisibleInFrames, readField } from '../browser/locators.mjs';
import { buildClinicalArtifact } from '../domain/build-export-artifact.mjs';

function normalize(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function dateOnly(value, label) {
  const text = normalize(value);
  let match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return text;
  match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) throw new Error(`${label} is not an exact supported date`);
  return `${match[3]}-${match[1].padStart(2, '0')}-${match[2].padStart(2, '0')}`;
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

export class QuickScribeBrowser {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.selectors = config.selectors;
    this.targets = new Map();
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
    const result = await firstVisibleInFrames(
      this.page,
      this.selectors.noteRows,
      'QuickScribe note rows'
    );
    const rows = result.scope.locator(this.selectors.noteRows);
    const targets = [];
    for (let index = 0; index < await rows.count() && targets.length < limit; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const status = normalize(await row.locator(this.selectors.noteStatus).first().innerText().catch(() => ''));
      if (status !== 'ATTESTED') continue;
      const jobId = await exactAttribute(row, this.selectors.noteIdAttribute, 'QuickScribe note row');
      const link = row.locator(this.selectors.noteOpenLink).first();
      const href = await link.getAttribute('href');
      if (!href) throw new Error('ATTESTED QuickScribe note row has no stable detail URL');
      const targetUrl = new URL(href, this.page.url());
      if (targetUrl.origin !== new URL(this.config.url).origin) {
        throw new Error('QuickScribe note detail URL changed to an unexpected origin');
      }
      if (targets.some((target) => target.jobId === jobId)) {
        throw new Error('QuickScribe queue contains a duplicate stable job ID');
      }
      const target = { jobId, url: targetUrl.href };
      this.targets.set(jobId, target);
      targets.push(target);
    }
    return targets;
  }

  async readDiagnoses() {
    const result = await firstVisibleInFrames(
      this.page,
      this.selectors.acceptedDiagnosisRows,
      'accepted QuickScribe ICD-10-CM diagnoses'
    );
    const rows = result.scope.locator(this.selectors.acceptedDiagnosisRows);
    const diagnoses = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const code = normalize(await row.locator(this.selectors.diagnosisCode).first().innerText().catch(() => ''));
      const description = this.selectors.diagnosisDescription
        ? normalize(await row.locator(this.selectors.diagnosisDescription).first().innerText().catch(() => ''))
        : '';
      diagnoses.push({ system: 'ICD10CM', code, description, reviewStatus: 'ACCEPTED' });
    }
    if (diagnoses.length === 0) throw new Error('ATTESTED QuickScribe note has no explicit accepted ICD-10-CM diagnoses');
    return diagnoses;
  }

  async extractTarget(target) {
    await this.page.goto(target.url, { waitUntil: 'domcontentloaded' });
    await this.assertAuthenticated();
    const root = await firstVisibleInFrames(
      this.page,
      this.selectors.noteDetailRoot,
      'QuickScribe note detail'
    );
    const jobId = await exactAttribute(root.locator, this.selectors.noteIdAttribute, 'QuickScribe note detail');
    if (jobId !== target.jobId) throw new Error('QuickScribe note identity changed between queue and detail page');
    const status = await exactText(this.page, this.selectors.detailStatus, 'QuickScribe note status');
    if (status !== 'ATTESTED') throw new Error('QuickScribe note is no longer ATTESTED');

    const finalNote = await clinicalText(this.page, this.selectors.finalNote, 'provider-approved QuickScribe note');
    const serviceDateText = await exactText(this.page, this.selectors.serviceDate, 'encounter service date');
    const attestationText = await exactText(this.page, this.selectors.attestationAt, 'provider attestation time');
    const patientId = await exactText(this.page, this.selectors.patientId, 'QuickRCM patient ID');
    const appointmentId = await exactText(this.page, this.selectors.appointmentId, 'QuickRCM appointment ID');

    return buildClinicalArtifact({
      status,
      jobId,
      patient: {
        id: patientId,
        firstName: await exactText(this.page, this.selectors.patientFirstName, 'patient first name'),
        lastName: await exactText(this.page, this.selectors.patientLastName, 'patient last name'),
        dob: dateOnly(await exactText(this.page, this.selectors.patientDob, 'patient DOB'), 'patient DOB'),
        prognocisPatientId: await optionalText(this.page, this.selectors.prognocisPatientId)
      },
      encounter: {
        appointmentId,
        startTime: `${dateOnly(serviceDateText, 'encounter service date')}T12:00:00.000Z`,
        appointmentType: await exactText(this.page, this.selectors.appointmentType, 'appointment type'),
        providerName: await optionalText(this.page, this.selectors.providerName),
        prognocisEncounterId: await optionalText(this.page, this.selectors.prognocisEncounterId)
      },
      attestation: {
        at: isoTimestamp(attestationText, 'provider attestation time'),
        byId: await exactText(this.page, this.selectors.attestationBy, 'provider attestation actor')
      },
      finalNote,
      diagnoses: await this.readDiagnoses()
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
