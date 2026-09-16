import {
  normalizeClinicalText,
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
  readField
} from '../browser/locators.mjs';

const SECTION_NAMES = ['hpi', 'ros', 'physicalExamination'];

function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function stableEncounterId(rawValue, configuredPattern) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  if (!configuredPattern) return raw;
  return String(raw.match(new RegExp(configuredPattern))?.[1] ?? '').trim();
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

async function firstEditableInFrames(page, selector, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    for (const scope of pageScopes(page)) {
      const locator = scope.locator(selector).first();
      if (await locator.isVisible().catch(() => false)
        && await locator.isEditable().catch(() => false)) {
        return { scope, locator };
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Editable element not found in any frame for ${label}`);
}

async function contextPageWithVisibleSelector(page, selector, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const candidates = [...page.context().pages()].reverse();
    for (const candidate of candidates) {
      if (candidate.isClosed()) continue;
      const found = await optionalVisibleInFrames(candidate, selector).catch(() => null);
      if (found) return candidate;
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Visible element not found in any browser page for ${label}`);
}

async function firstVisibleInSectionFrame(
  page,
  selector,
  configuredUrlPattern,
  label,
  timeoutMs = 10_000
) {
  if (!configuredUrlPattern) return firstVisibleInFrames(page, selector, label, timeoutMs);
  const urlPattern = new RegExp(configuredUrlPattern, 'i');
  const deadline = Date.now() + timeoutMs;
  do {
    for (const scope of pageScopes(page)) {
      try {
        if (!urlPattern.test(scope.url())) continue;
        const locator = scope.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) return { scope, locator };
      } catch {
        // PrognoCIS replaces the clinical-content frame while a section loads.
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Visible element not found in the configured section frame for ${label}`);
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

  async dismissTransientOverlay({ waitForPossible = false } = {}) {
    if (!this.selectors.transientOverlayDismiss) return;
    const deadline = Date.now() + (waitForPossible
      ? (this.config.transientOverlayWaitMs ?? 1_500)
      : 0);
    do {
      const dismiss = await optionalVisibleInFrames(this.rootPage, this.selectors.transientOverlayDismiss);
      if (dismiss) {
        await dismiss.locator.click();
        await this.rootPage.waitForTimeout(100);
        return;
      }
      if (!waitForPossible) return;
      await this.rootPage.waitForTimeout(100);
    } while (Date.now() < deadline);
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

  async clearStaleWindowLocks() {
    const origin = new URL(this.config.loginUrl).origin;
    const cookies = await this.page.context().cookies(origin);
    for (const cookie of cookies) {
      if (!['cookie-windowname', 'cookie-windowdom'].includes(cookie.name)) continue;
      await this.page.context().clearCookies({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path
      });
    }
  }

  async open() {
    const authenticatedPage = await this.findAuthenticatedApplicationPage();
    if (authenticatedPage) {
      this.page = authenticatedPage;
      this.rootPage = authenticatedPage;
      return;
    }
    await this.page.waitForLoadState('domcontentloaded');
    let password = await optionalVisibleInFrames(this.page, this.selectors.loginPassword);
    if (!password) {
      const patientControl = await optionalVisibleInFrames(this.page, this.selectors.selectPatient);
      if (patientControl) {
        this.rootPage = this.page;
        return;
      }
      if (!this.config.loginPerRun) throw new AuthenticationRequiredError();
      await this.clearStaleWindowLocks();
      await this.page.goto(this.config.loginUrl, { waitUntil: 'domcontentloaded' });
      password = await firstVisibleInFrames(
        this.page,
        this.selectors.loginPassword,
        'PrognoCIS login password'
      );
    } else if (!this.config.loginPerRun) {
      throw new AuthenticationRequiredError();
    }
    if (!this.credentials.username || !this.credentials.password) throw new AuthenticationRequiredError();

    await this.clearStaleWindowLocks();

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
    await clickInFrames(this.page, this.selectors.selectPatient, 'PrognoCIS Select Patient');
    const searchPage = await contextPageWithVisibleSelector(
      this.page,
      this.selectors.patientFirstName,
      'PrognoCIS patient search',
      this.config.popupTimeoutMs
    );
    if (this.config.patientSearchUrlPattern
      && searchPage !== this.page
      && !new RegExp(this.config.patientSearchUrlPattern, 'i').test(searchPage.url())) {
      throw new Error('PrognoCIS patient search opened an unexpected URL');
    }
    this.watchDialogs(searchPage);
    await searchPage.waitForLoadState('domcontentloaded');
    return searchPage;
  }

  async openEncounterHistory() {
    await this.dismissTransientOverlay();
    const popupPromise = this.rootPage.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(
      this.rootPage,
      this.selectors.encounterMenu,
      'PrognoCIS encounter menu',
      { allowHiddenLegacy: true }
    );
    let historyPage = await popupPromise;
    if (!historyPage && this.config.encounterHistoryUrlPattern) {
      const pattern = new RegExp(this.config.encounterHistoryUrlPattern, 'i');
      historyPage = this.rootPage.context().pages().find((candidate) => (
        !candidate.isClosed() && candidate !== this.rootPage && pattern.test(candidate.url())
      ));
    }
    historyPage ??= this.rootPage;
    this.watchDialogs(historyPage);
    await historyPage.waitForLoadState('domcontentloaded');
    return historyPage;
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
    let matches = [];
    const deadline = Date.now() + (this.config.patientSearchTimeoutMs ?? 10_000);
    do {
      matches = [];
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
      if (matches.length > 0) break;
      await searchPage.waitForTimeout(100);
    } while (Date.now() < deadline);
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
    await this.dismissTransientOverlay({ waitForPossible: true });
    this.assertNoUnexpectedDialog();
  }

  async findExactEncounter(encounter) {
    if (encounter.providerName && !this.selectors.encounterProviderCell) {
      throw new Error('Encounter has providerName but no exact provider-cell selector is configured');
    }
    const historyPage = await this.openEncounterHistory();
    try {
      const rowsResult = await firstVisibleInFrames(
        historyPage,
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
        const rawEncounterId = await row.getAttribute(this.selectors.encounterIdAttribute);
        const encounterId = stableEncounterId(rawEncounterId, this.config.encounterIdPattern);
        const status = this.selectors.encounterStatusCell
          ? await row.locator(this.selectors.encounterStatusCell).first().innerText().catch(() => '')
          : '';
        if (encounterCellsMatch({ dateText, typeText, providerText, encounterId }, encounter, this.automation.timezone)) {
          matches.push({ row, encounterId, status: String(status).trim(), historyPage });
        }
      }
      return requireOneMatch(matches, 'encounter');
    } catch (error) {
      if (historyPage !== this.rootPage && !historyPage.isClosed()) await historyPage.close().catch(() => {});
      throw error;
    }
  }

  async openMatchedEncounter(exact) {
    if (!exact.encounterId || !/^[A-Za-z0-9._:-]{1,200}$/.test(exact.encounterId)) {
      throw new Error('Exact PrognoCIS encounter has no valid stable encounter ID');
    }
    if (this.selectors.encounterOpen) {
      await firstVisible(exact.row, this.selectors.encounterOpen, 'encounter open control');
      await exact.row.locator(this.selectors.encounterOpen).first().click();
    } else {
      await exact.row.click({ noWaitAfter: true }).catch((error) => {
        if (!exact.historyPage.isClosed()) throw error;
      });
    }
    if (exact.historyPage !== this.rootPage && !exact.historyPage.isClosed()) {
      const closed = await exact.historyPage.waitForEvent('close', {
        timeout: this.config.popupTimeoutMs
      }).then(() => true).catch(() => false);
      if (!closed) throw new Error('PrognoCIS encounter history did not close after exact selection');
    }
    this.page = this.rootPage;
    this.editorPage = this.rootPage;
    this.watchDialogs(this.editorPage);
    await firstVisibleInFrames(
      this.editorPage,
      this.selectors.encounterEditorReady,
      'PrognoCIS encounter editor'
    );
    await this.dismissTransientOverlay({ waitForPossible: true });
    this.currentEncounterStatus = exact.status;
    this.assertNoUnexpectedDialog();
    return exact.encounterId;
  }

  async openExactEncounter(encounter) {
    return this.openMatchedEncounter(await this.findExactEncounter(encounter));
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

  async selectHpiComplaint(appointmentType) {
    const complaintName = this.config.hpiComplaintByAppointmentType?.[appointmentType];
    if (!complaintName) {
      throw new Error('No exact HPI complaint mapping exists for this appointment type');
    }
    await clickInFrames(
      this.editorPage,
      this.selectors.hpiComplaintLookupButton,
      'HPI complaint lookup'
    );
    const complaintPage = await contextPageWithVisibleSelector(
      this.editorPage,
      this.selectors.hpiComplaintSearchInput,
      'HPI complaint search',
      this.config.popupTimeoutMs
    );
    this.watchDialogs(complaintPage);
    const search = await firstVisibleInFrames(
      complaintPage,
      this.selectors.hpiComplaintSearchInput,
      'HPI complaint search'
    );
    await fillField(search.locator, complaintName);
    if (this.selectors.hpiComplaintSearchButton) {
      await clickInFrames(complaintPage, this.selectors.hpiComplaintSearchButton, 'HPI complaint search action');
    } else {
      await search.locator.dispatchEvent('keyup', {
        key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39
      });
    }
    const rowsResult = await firstVisibleInFrames(
      complaintPage,
      this.selectors.hpiComplaintRows,
      'HPI complaint results'
    );
    const rows = rowsResult.scope.locator(this.selectors.hpiComplaintRows);
    let matches = [];
    const deadline = Date.now() + (this.config.patientSearchTimeoutMs ?? 10_000);
    do {
      matches = [];
      for (let index = 0; index < await rows.count(); index += 1) {
        const row = rows.nth(index);
        if (!(await row.isVisible().catch(() => false))) continue;
        const name = this.selectors.hpiComplaintNameCell
          ? await row.locator(this.selectors.hpiComplaintNameCell).first().innerText().catch(() => '')
          : await row.innerText().catch(() => '');
        if (normalize(name) === normalize(complaintName)) matches.push(row);
      }
      if (matches.length > 0) break;
      await complaintPage.waitForTimeout(100);
    } while (Date.now() < deadline);
    const exact = requireOneMatch(matches, 'HPI complaint');
    const closes = complaintPage !== this.editorPage
      ? complaintPage.waitForEvent('close', { timeout: this.config.popupTimeoutMs }).catch(() => null)
      : null;
    if (this.selectors.hpiComplaintSelectButton) {
      await exact.locator(this.selectors.hpiComplaintSelectButton).first().click();
    } else {
      await exact.click();
    }
    if (this.selectors.hpiComplaintConfirmButton) {
      await clickInFrames(
        complaintPage,
        this.selectors.hpiComplaintConfirmButton,
        'confirm HPI complaint'
      );
    }
    if (complaintPage !== this.editorPage && !complaintPage.isClosed() && !(await closes)) {
      throw new Error('PrognoCIS HPI complaint search did not close after exact selection');
    }
    this.assertNoUnexpectedDialog();
  }

  async sectionField(section, appointmentType, { allowTemplate = false } = {}) {
    await this.dismissTransientOverlay();
    await clickInFrames(
      this.editorPage,
      this.selectors[`${section}Menu`],
      `PrognoCIS ${section} section`,
      { allowHiddenLegacy: true }
    );
    let field = await firstVisibleInSectionFrame(
      this.editorPage,
      this.selectors[`${section}Field`],
      this.config.sectionUrlPatterns?.[section],
      `PrognoCIS ${section} narrative field`,
      this.config.sectionLoadTimeoutMs ?? 10_000
    ).catch(() => null);
    let editable = field && await field.locator.isEditable().catch(() => false);
    if (section === 'hpi' && allowTemplate && (!field || !editable)
      && this.selectors.hpiComplaintLookupButton) {
      await this.selectHpiComplaint(appointmentType);
      field = await firstEditableInFrames(
        this.editorPage,
        this.selectors.hpiField,
        'PrognoCIS HPI field after complaint selection',
        this.config.sectionLoadTimeoutMs ?? 10_000
      );
      editable = await field.locator.isEditable().catch(() => false);
    }
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

  async inspectDraft(artifact, options = {}) {
    const sections = await this.readSections(artifact, options);
    const sectionState = Object.fromEntries(SECTION_NAMES.map((section) => {
      const actual = normalizeClinicalText(sections[section]);
      const expected = normalizeClinicalText(artifact.sections[section]);
      return [section, { empty: !actual, matches: actual === expected }];
    }));
    return {
      sections: sectionState,
      exact: Object.values(sectionState).every(({ matches }) => matches)
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
        allowTemplate: false
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

  async encounterStatusIs(artifact, expectedEncounterId, configuredPattern) {
    const exact = await this.findExactEncounter(artifact.encounter);
    if (exact.encounterId !== expectedEncounterId) {
      if (exact.historyPage !== this.rootPage && !exact.historyPage.isClosed()) {
        await exact.historyPage.close().catch(() => {});
      }
      throw new Error('PrognoCIS encounter identity changed during status verification');
    }
    const matches = new RegExp(configuredPattern, 'i').test(exact.status.trim());
    await this.openMatchedEncounter(exact);
    return matches;
  }

  async saveDraftAndVerifyStatus(artifact, expectedEncounterId) {
    await waitForConfiguredSave(this.editorPage, {
      urlPattern: this.config.draftSaveUrlPattern,
      successSelector: this.selectors.draftSaveSuccess,
      timeoutMs: this.config.saveTimeoutMs ?? 90_000,
      label: 'PrognoCIS draft save'
    }, () => clickInFrames(this.editorPage, this.selectors.saveDraftButton, 'PrognoCIS Save Draft'));
    const verified = this.selectors.encounterStatusCell
      ? await this.encounterStatusIs(artifact, expectedEncounterId, this.config.draftStatusPattern)
      : await this.statusSelectorMatches(this.config.draftStatusPattern, 'PrognoCIS draft status');
    if (!verified) {
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

  async statusSelectorMatches(pattern, label) {
    const status = await firstVisibleInFrames(
      this.editorPage,
      this.selectors.draftStatus,
      label
    );
    const statusText = await status.locator.innerText().catch(() => '');
    return new RegExp(pattern, 'i').test(statusText.trim());
  }

  async verifyDraftStatus(artifact, expectedEncounterId) {
    if (this.selectors.encounterStatusCell) {
      return this.encounterStatusIs(artifact, expectedEncounterId, this.config.draftStatusPattern);
    }
    return this.statusSelectorMatches(this.config.draftStatusPattern, 'reopened PrognoCIS draft status');
  }

  async assertEncounterIsEditable() {
    const statusText = this.selectors.encounterStatusCell
      ? this.currentEncounterStatus
      : await (async () => {
        const status = await firstVisibleInFrames(
          this.editorPage,
          this.selectors.draftStatus,
          'current PrognoCIS encounter status'
        );
        return status.locator.innerText().catch(() => '');
      })();
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
    const before = await this.inspectDraft(artifact);
    if (before.exact && await this.verifyDraftStatus(artifact, ehrEncounterId)) {
      return {
        status: 'DRAFT_VERIFIED',
        ehrEncounterId,
        artifactHash: artifact.artifactHash,
        duplicate: true
      };
    }
    this.assertNoDifferentClinicalText(before);
    await this.writeMissingSections(artifact, before);
    await this.saveDraftAndVerifyStatus(artifact, ehrEncounterId);

    await this.reopenExactEncounter(artifact, ehrEncounterId);
    const after = await this.inspectDraft(artifact);
    if (!after.exact || !(await this.verifyDraftStatus(artifact, ehrEncounterId))) {
      const error = new Error('Reopened PrognoCIS draft did not match the approved clinical artifact');
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
