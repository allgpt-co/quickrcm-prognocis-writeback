import {
  normalizeClinicalText,
  textContainsExactCode,
  validateClinicalArtifact
} from '../domain/clinical-artifact.mjs';
import {
  encounterCellsMatch,
  patientRowMatches,
  requireOneMatch
} from '../domain/matching.mjs';
import {
  AuthenticationRequiredError,
  clickInFrames,
  fillField,
  firstVisible,
  firstVisibleInFrames,
  optionalVisibleInFrames,
  pageScopes,
  readField,
  visibleTextsInFrames
} from '../browser/locators.mjs';

const SECTION_NAMES = ['hpi', 'ros', 'physicalExamination'];

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function waitForConfiguredSave(page, { urlPattern, successSelector, timeoutMs, label }, action) {
  const responsePromise = urlPattern
    ? page.waitForResponse((response) => response.request().method() === 'POST'
      && new RegExp(urlPattern, 'i').test(response.url()), { timeout: timeoutMs })
    : null;
  await action();
  if (responsePromise) {
    const response = await responsePromise;
    if (!response.ok()) throw new Error(`${label} returned HTTP ${response.status()}`);
  }
  if (successSelector) await firstVisibleInFrames(page, successSelector, `${label} confirmation`, timeoutMs);
}

export class PrognocisBrowser {
  constructor(page, config, automation, credentials = {}) {
    this.page = page;
    this.rootPage = page;
    this.editorPage = page;
    this.config = config;
    this.automation = automation;
    this.credentials = credentials;
    this.selectors = config.selectors;
    this.unexpectedDialog = null;
    this.watchedPages = new WeakSet();
    this.watchDialogs(page);
  }

  watchDialogs(page) {
    if (this.watchedPages.has(page)) return;
    page.on('dialog', async (dialog) => {
      this.unexpectedDialog = dialog.type();
      await dialog.dismiss().catch(() => {});
    });
    this.watchedPages.add(page);
  }

  assertNoUnexpectedDialog() {
    if (!this.unexpectedDialog) return;
    const error = new Error('PrognoCIS displayed an unexpected browser dialog; operation stopped');
    error.code = 'UNEXPECTED_DIALOG';
    throw error;
  }

  async findAuthenticatedApplicationPage() {
    const expectedOrigin = new URL(this.config.url).origin;
    for (const candidate of this.page.context().pages()) {
      if (candidate.isClosed()) continue;
      let candidateOrigin;
      try {
        candidateOrigin = new URL(candidate.url()).origin;
      } catch {
        continue;
      }
      if (candidateOrigin !== expectedOrigin) continue;
      const patientControl = await optionalVisibleInFrames(candidate, this.selectors.selectPatient);
      if (!patientControl) continue;
      this.watchDialogs(candidate);
      return candidate;
    }
    return null;
  }

  async open() {
    const authenticatedPage = await this.findAuthenticatedApplicationPage();
    if (authenticatedPage) {
      this.page = authenticatedPage;
      this.rootPage = authenticatedPage;
      return;
    }
    await this.page.waitForLoadState('domcontentloaded');
    const password = await optionalVisibleInFrames(this.page, this.selectors.loginPassword);
    if (!password) {
      await firstVisibleInFrames(this.page, this.selectors.selectPatient, 'PrognoCIS patient selector');
      this.rootPage = this.page;
      return;
    }
    if (!this.config.loginPerRun) throw new AuthenticationRequiredError();
    if (!this.credentials.username || !this.credentials.password) throw new AuthenticationRequiredError();

    const username = await firstVisibleInFrames(
      this.page,
      this.selectors.loginUsername,
      'PrognoCIS username'
    );
    await fillField(username.locator, this.credentials.username);
    await fillField(password.locator, this.credentials.password);
    const popupPromise = this.page.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(this.page, this.selectors.loginButton, 'PrognoCIS login');
    const popup = await popupPromise;
    if (popup) {
      this.page = popup;
      this.watchDialogs(popup);
      await popup.waitForLoadState('domcontentloaded');
    }
    try {
      await firstVisibleInFrames(
        this.page,
        this.selectors.selectPatient,
        'authenticated PrognoCIS patient selector',
        this.config.loginTimeoutMs
      );
    } catch {
      throw new AuthenticationRequiredError();
    }
    this.assertNoUnexpectedDialog();
    this.rootPage = this.page;
  }

  async openPatientSearch() {
    const popupPromise = this.page.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(this.page, this.selectors.selectPatient, 'PrognoCIS Select Patient');
    let searchPage = await popupPromise;
    if (!searchPage && this.config.patientSearchUrlPattern) {
      const pattern = new RegExp(this.config.patientSearchUrlPattern, 'i');
      searchPage = this.page.context().pages().find((candidate) => pattern.test(candidate.url()));
    }
    searchPage ??= this.page;
    this.watchDialogs(searchPage);
    await searchPage.waitForLoadState('domcontentloaded');
    return searchPage;
  }

  async selectPatient(patient) {
    if (patient.prognocisPatientId && !this.selectors.patientResultIdAttribute) {
      throw new Error('Patient has a retained PrognoCIS ID but no patient ID attribute is configured');
    }
    const searchPage = await this.openPatientSearch();
    const firstName = await firstVisibleInFrames(
      searchPage,
      this.selectors.patientFirstName,
      'PrognoCIS patient first name'
    );
    const lastName = await firstVisibleInFrames(
      searchPage,
      this.selectors.patientLastName,
      'PrognoCIS patient last name'
    );
    await fillField(lastName.locator, patient.lastName);
    await fillField(firstName.locator, patient.firstName);
    if (this.selectors.patientSearchButton) {
      await clickInFrames(searchPage, this.selectors.patientSearchButton, 'PrognoCIS patient search');
    } else {
      await firstName.locator.dispatchEvent('keyup', {
        key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39
      });
    }

    const rowsResult = await firstVisibleInFrames(
      searchPage,
      this.selectors.patientResultRows,
      'PrognoCIS patient results'
    );
    const rows = rowsResult.scope.locator(this.selectors.patientResultRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      if (!patientRowMatches(await row.innerText().catch(() => ''), patient)) continue;
      if (patient.prognocisPatientId && this.selectors.patientResultIdAttribute) {
        const candidateId = await row.getAttribute(this.selectors.patientResultIdAttribute);
        if (normalize(candidateId) !== normalize(patient.prognocisPatientId)) continue;
      }
      matches.push(row);
    }
    const exact = requireOneMatch(matches, 'patient identity');
    const closes = searchPage === this.page
      ? null
      : searchPage.waitForEvent('close', { timeout: this.config.popupTimeoutMs }).catch(() => null);
    await exact.click({ noWaitAfter: true }).catch((error) => {
      if (!searchPage.isClosed()) throw error;
    });
    if (closes && !(await closes)) throw new Error('PrognoCIS patient search did not close after exact selection');

    const identity = await firstVisibleInFrames(
      this.page,
      this.selectors.activePatientIdentity,
      'active PrognoCIS patient identity'
    );
    if (!patientRowMatches(await identity.locator.innerText().catch(() => ''), patient)) {
      throw new Error('Active PrognoCIS chart does not match the exact selected patient');
    }
    this.assertNoUnexpectedDialog();
  }

  async openExactEncounter(encounter) {
    if (encounter.providerName && !this.selectors.encounterProviderCell) {
      throw new Error('Encounter has providerName but no exact provider-cell selector is configured');
    }
    await clickInFrames(
      this.page,
      this.selectors.encounterMenu,
      'PrognoCIS encounter menu',
      { allowHiddenLegacy: true }
    );
    const rowsResult = await firstVisibleInFrames(
      this.page,
      this.selectors.encounterRows,
      'PrognoCIS encounter rows'
    );
    const rows = rowsResult.scope.locator(this.selectors.encounterRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;
      const dateText = await row.locator(this.selectors.encounterDateCell).first().innerText().catch(() => '');
      const typeText = await row.locator(this.selectors.encounterTypeCell).first().innerText().catch(() => '');
      const providerText = this.selectors.encounterProviderCell
        ? await row.locator(this.selectors.encounterProviderCell).first().innerText().catch(() => '')
        : '';
      const encounterId = await row.getAttribute(this.selectors.encounterIdAttribute);
      if (encounterCellsMatch({ dateText, typeText, providerText, encounterId }, encounter, this.automation.timezone)) {
        matches.push({ row, encounterId });
      }
    }
    const exact = requireOneMatch(matches, 'encounter');
    if (!exact.encounterId || !/^[A-Za-z0-9._:-]{1,200}$/.test(exact.encounterId)) {
      throw new Error('Exact PrognoCIS encounter has no valid stable encounter ID');
    }

    const popupPromise = this.page.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    if (this.selectors.encounterOpen) {
      await firstVisible(exact.row, this.selectors.encounterOpen, 'encounter open control');
      await exact.row.locator(this.selectors.encounterOpen).first().click();
    } else {
      await exact.row.click();
    }
    const popup = await popupPromise;
    this.editorPage = popup ?? this.page;
    this.watchDialogs(this.editorPage);
    if (popup) await popup.waitForLoadState('domcontentloaded');
    await firstVisibleInFrames(
      this.editorPage,
      this.selectors.encounterEditorReady,
      'PrognoCIS encounter editor'
    );
    this.assertNoUnexpectedDialog();
    return exact.encounterId;
  }

  async selectHpiTemplate(appointmentType) {
    const templateName = this.config.hpiTemplateByAppointmentType?.[appointmentType];
    if (!templateName) {
      throw new Error('No exact HPI template mapping exists for this appointment type');
    }
    const popupPromise = this.editorPage.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(this.editorPage, this.selectors.hpiTemplateButton, 'HPI template lookup');
    const templatePage = await popupPromise ?? this.editorPage;
    this.watchDialogs(templatePage);
    const rowsResult = await firstVisibleInFrames(
      templatePage,
      this.selectors.hpiTemplateResultRows,
      'HPI template results'
    );
    const rows = rowsResult.scope.locator(this.selectors.hpiTemplateResultRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (normalize(await row.innerText().catch(() => '')) === normalize(templateName)) matches.push(row);
    }
    const exact = requireOneMatch(matches, 'HPI template');
    if (this.selectors.hpiTemplateSelectButton) {
      await exact.locator(this.selectors.hpiTemplateSelectButton).first().click();
    } else {
      await exact.click();
    }
    if (templatePage !== this.editorPage) {
      await templatePage.waitForEvent('close', { timeout: this.config.popupTimeoutMs }).catch(() => {});
    }
    this.assertNoUnexpectedDialog();
  }

  async sectionField(section, appointmentType, { allowTemplate = false } = {}) {
    await clickInFrames(
      this.editorPage,
      this.selectors[`${section}Menu`],
      `PrognoCIS ${section} section`,
      { allowHiddenLegacy: true }
    );
    let field = await optionalVisibleInFrames(this.editorPage, this.selectors[`${section}Field`]);
    const editable = field && await field.locator.isEditable().catch(() => false);
    if (section === 'hpi' && allowTemplate && (!field || !editable) && this.selectors.hpiTemplateButton) {
      await this.selectHpiTemplate(appointmentType);
      field = await firstVisibleInFrames(this.editorPage, this.selectors.hpiField, 'PrognoCIS HPI field');
    }
    if (!field) {
      throw new Error(`Visible PrognoCIS ${section} narrative field was not found`);
    }
    return field.locator;
  }

  async readSections(artifact, options = {}) {
    const values = {};
    for (const section of SECTION_NAMES) {
      const field = await this.sectionField(section, artifact.encounter.appointmentType, options);
      values[section] = await readField(field);
    }
    return values;
  }

  async readDiagnoses() {
    await clickInFrames(
      this.editorPage,
      this.selectors.diagnosisMenu,
      'PrognoCIS diagnoses',
      { allowHiddenLegacy: true }
    );
    return visibleTextsInFrames(this.editorPage, this.selectors.existingDiagnosisRows);
  }

  async inspectDraft(artifact, options = {}) {
    const sections = await this.readSections(artifact, options);
    const diagnosisRows = await this.readDiagnoses();
    const sectionState = Object.fromEntries(SECTION_NAMES.map((section) => {
      const actual = normalizeClinicalText(sections[section]);
      const expected = normalizeClinicalText(artifact.sections[section]);
      return [section, { empty: !actual, matches: actual === expected }];
    }));
    const diagnosisState = artifact.diagnoses.map((diagnosis) => ({
      diagnosis,
      present: diagnosisRows.some((row) => textContainsExactCode(row, diagnosis.code))
    }));
    return {
      sections: sectionState,
      diagnoses: diagnosisState,
      exact: Object.values(sectionState).every(({ matches }) => matches)
        && diagnosisState.every(({ present }) => present)
    };
  }

  assertNoDifferentClinicalText(state) {
    for (const [section, value] of Object.entries(state.sections)) {
      if (!value.empty && !value.matches) {
        const error = new Error(`PrognoCIS ${section} already contains different text; refusing overwrite`);
        error.code = 'CLINICAL_TEXT_CONFLICT';
        throw error;
      }
    }
  }

  async writeMissingSections(artifact, state) {
    for (const section of SECTION_NAMES) {
      if (state.sections[section].matches) continue;
      const field = await this.sectionField(section, artifact.encounter.appointmentType, {
        allowTemplate: true
      });
      if (!(await field.isEditable().catch(() => false))) {
        throw new Error(`PrognoCIS ${section} narrative field is not editable`);
      }
      await fillField(field, artifact.sections[section]);
      if (normalizeClinicalText(await readField(field)) !== normalizeClinicalText(artifact.sections[section])) {
        throw new Error(`PrognoCIS ${section} field did not retain the approved text before save`);
      }
      await waitForConfiguredSave(this.editorPage, {
        urlPattern: this.config.sectionSaveUrlPattern,
        successSelector: this.selectors.sectionSaveSuccess,
        timeoutMs: this.config.saveTimeoutMs ?? 90_000,
        label: `PrognoCIS ${section} save`
      }, () => clickInFrames(
        this.editorPage,
        this.selectors[`${section}SaveButton`],
        `PrognoCIS ${section} Save`
      ));
      this.assertNoUnexpectedDialog();
    }
  }

  async addDiagnosis(diagnosis) {
    await clickInFrames(
      this.editorPage,
      this.selectors.diagnosisMenu,
      'PrognoCIS diagnoses',
      { allowHiddenLegacy: true }
    );
    const popupPromise = this.editorPage.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(this.editorPage, this.selectors.diagnosisAddButton, 'add ICD-10-CM diagnosis');
    const searchPage = await popupPromise ?? this.editorPage;
    this.watchDialogs(searchPage);
    const search = await firstVisibleInFrames(
      searchPage,
      this.selectors.diagnosisSearchInput,
      'ICD-10-CM diagnosis search'
    );
    await fillField(search.locator, diagnosis.code);
    if (this.selectors.diagnosisSearchButton) {
      await clickInFrames(searchPage, this.selectors.diagnosisSearchButton, 'ICD-10-CM search action');
    } else {
      await search.locator.press('Enter');
    }
    const result = await firstVisibleInFrames(
      searchPage,
      this.selectors.diagnosisResultRows,
      'ICD-10-CM search results'
    );
    const rows = result.scope.locator(this.selectors.diagnosisResultRows);
    const matches = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (textContainsExactCode(await row.innerText().catch(() => ''), diagnosis.code)) matches.push(row);
    }
    const exact = requireOneMatch(matches, 'ICD-10-CM code');
    if (this.selectors.diagnosisSelectButton) {
      await exact.locator(this.selectors.diagnosisSelectButton).first().click();
    } else {
      await exact.click();
    }
    if (searchPage !== this.editorPage) {
      await searchPage.waitForEvent('close', { timeout: this.config.popupTimeoutMs }).catch(() => {});
    }
    this.assertNoUnexpectedDialog();
  }

  async saveDraftAndVerifyStatus() {
    await waitForConfiguredSave(this.editorPage, {
      urlPattern: this.config.draftSaveUrlPattern,
      successSelector: this.selectors.draftSaveSuccess,
      timeoutMs: this.config.saveTimeoutMs ?? 90_000,
      label: 'PrognoCIS draft save'
    }, () => clickInFrames(this.editorPage, this.selectors.saveDraftButton, 'PrognoCIS Save Draft'));
    const status = await firstVisibleInFrames(
      this.editorPage,
      this.selectors.draftStatus,
      'PrognoCIS draft status'
    );
    const statusText = await status.locator.innerText().catch(() => '');
    if (!new RegExp(this.config.draftStatusPattern, 'i').test(statusText.trim())) {
      throw new Error('PrognoCIS did not display the configured Draft status after save');
    }
    this.assertNoUnexpectedDialog();
  }

  async reopenExactEncounter(artifact, expectedEncounterId) {
    if (this.editorPage !== this.rootPage && !this.editorPage.isClosed()) {
      await this.editorPage.close({ runBeforeUnload: false });
    }
    this.page = this.rootPage;
    if (this.page.isClosed()) throw new Error('PrognoCIS root page closed before verification');
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded' });
    await this.open();
    await this.selectPatient(artifact.patient);
    const reopenedId = await this.openExactEncounter(artifact.encounter);
    if (reopenedId !== expectedEncounterId) {
      throw new Error('PrognoCIS encounter identity changed during read-back verification');
    }
    return reopenedId;
  }

  async verifyDraftStatus() {
    const status = await firstVisibleInFrames(
      this.editorPage,
      this.selectors.draftStatus,
      'reopened PrognoCIS draft status'
    );
    const statusText = await status.locator.innerText().catch(() => '');
    return new RegExp(this.config.draftStatusPattern, 'i').test(statusText.trim());
  }

  async assertEncounterIsEditable() {
    const status = await firstVisibleInFrames(
      this.editorPage,
      this.selectors.draftStatus,
      'current PrognoCIS encounter status'
    );
    const statusText = await status.locator.innerText().catch(() => '');
    if (!new RegExp(this.config.editableStatusPattern, 'i').test(statusText.trim())) {
      const error = new Error('PrognoCIS encounter is not in a configured editable pre-draft state');
      error.code = 'ENCOUNTER_NOT_EDITABLE';
      throw error;
    }
  }

  async process(rawArtifact, { writeEnabled }) {
    const artifact = validateClinicalArtifact(rawArtifact);
    if (this.editorPage !== this.rootPage && !this.editorPage.isClosed()) {
      await this.editorPage.close({ runBeforeUnload: false });
    }
    this.page = this.rootPage;
    this.editorPage = this.rootPage;
    this.unexpectedDialog = null;
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded' });
    await this.open();
    await this.selectPatient(artifact.patient);
    const ehrEncounterId = await this.openExactEncounter(artifact.encounter);
    if (!writeEnabled) {
      return { status: 'PROBED', ehrEncounterId, artifactHash: artifact.artifactHash };
    }

    await this.assertEncounterIsEditable();
    const before = await this.inspectDraft(artifact, { allowTemplate: true });
    if (before.exact && await this.verifyDraftStatus()) {
      return {
        status: 'DRAFT_VERIFIED',
        ehrEncounterId,
        artifactHash: artifact.artifactHash,
        duplicate: true
      };
    }
    this.assertNoDifferentClinicalText(before);
    await this.writeMissingSections(artifact, before);
    for (const item of before.diagnoses) {
      if (!item.present) await this.addDiagnosis(item.diagnosis);
    }
    await this.saveDraftAndVerifyStatus();

    await this.reopenExactEncounter(artifact, ehrEncounterId);
    const after = await this.inspectDraft(artifact);
    if (!after.exact || !(await this.verifyDraftStatus())) {
      const error = new Error('Reopened PrognoCIS draft did not match every approved section and ICD-10-CM code');
      error.code = 'DRAFT_READBACK_FAILED';
      throw error;
    }
    return {
      status: 'DRAFT_VERIFIED',
      ehrEncounterId,
      artifactHash: artifact.artifactHash,
      duplicate: false
    };
  }
}
