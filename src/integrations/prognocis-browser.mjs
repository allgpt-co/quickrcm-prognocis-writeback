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
  fillCredentialField,
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

function complaintNamePattern(value) {
  // PrognoCIS decorates an encounter's complaint name with a leading checkmark.
  const name = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  return new RegExp(`^\\s*(?:[✓✔]\\s*)?${name}\\s*$`, 'iu');
}

function stableEncounterId(rawValue, configuredPattern) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  if (!configuredPattern) return raw;
  return String(raw.match(new RegExp(configuredPattern))?.[1] ?? '').trim();
}

export function stablePatientId(rawValue, configuredPattern) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return '';
  if (!configuredPattern) return raw;
  return String(raw.match(new RegExp(configuredPattern))?.[1] ?? '').trim();
}

export async function waitForConfiguredSave(page, { urlPattern, successSelector, timeoutMs, label }, action) {
  const responsePromise = urlPattern
    ? page.waitForResponse((response) => response.request().method() === 'POST'
      && new RegExp(urlPattern, 'i').test(response.url()), { timeout: timeoutMs })
    : null;
  const responseObserver = responsePromise?.then(
    (response) => ({ ok: true, response, error: null }),
    (error) => ({ ok: false, response: null, error })
  ) ?? null;
  try {
    await action();
  } catch (error) {
    void responseObserver;
    throw error;
  }
  if (responseObserver) {
    const outcome = await responseObserver;
    if (!outcome.ok) throw outcome.error;
    if (!outcome.response.ok()) {
      throw new Error(`${label} returned HTTP ${outcome.response.status()}`);
    }
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

async function valueInFrames(page, selector) {
  if (!selector) return '';
  for (const scope of pageScopes(page)) {
    const matches = scope.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      const value = await locator.inputValue().catch(() => locator.getAttribute('value'));
      if (String(value ?? '').trim()) return String(value).trim();
    }
  }
  return '';
}

async function requireValueInFrames(page, selector, expected, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await valueInFrames(page, selector) === expected) return expected;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  const error = new Error(`${label} did not become active after exact selection`);
  error.code = 'HPI_COMPLAINT_NOT_ACTIVE';
  throw error;
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
    await fillCredentialField(username.locator, this.credentials.username, 'PrognoCIS');
    await fillCredentialField(password.locator, this.credentials.password, 'PrognoCIS');
    const popupPromise = this.page.context().waitForEvent('page', {
      timeout: this.config.popupTimeoutMs
    }).catch(() => null);
    await clickInFrames(this.page, this.selectors.loginButton, 'PrognoCIS login', {
      retryOnTransient: false
    });
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

  async findEncounterHpiComplaint(complaintName, expectedId) {
    const { scope } = await firstVisibleInSectionFrame(
      this.editorPage, this.selectors.hpiComplaintLookupButton,
      this.config.sectionUrlPatterns?.hpi, 'HPI encounter complaint controls',
      this.config.sectionLoadTimeoutMs ?? 10_000
    );
    await scope.waitForLoadState('domcontentloaded');
    // Keep the locator bound to the exact name, not nth(row), even if rows move
    // between inspection and the subsequent click/check action.
    const row = scope.locator(this.selectors.hpiEncounterComplaintRows).filter({
      has: scope.locator(this.selectors.hpiEncounterComplaintNameCell)
        .filter({ hasText: complaintNamePattern(complaintName) })
    });
    const count = await row.count();
    if (count === 0) return null;
    if (count !== 1) {
      throw new Error(`PrognoCIS returned ${count} exact encounter HPI complaint matches; expected one`);
    }
    if (!(await row.isVisible())) return null;
    const nameCell = row.locator(this.selectors.hpiEncounterComplaintNameCell);
    if (await nameCell.count() !== 1) {
      throw new Error('Exact encounter HPI complaint must have one name/activation cell');
    }
    const checkbox = row.locator(this.selectors.hpiEncounterComplaintCheckbox);
    if (await checkbox.count() !== 1) {
      throw new Error('Exact encounter HPI complaint must have one chief-complaint checkbox');
    }
    const index = (await checkbox.getAttribute('id'))?.match(/^ccomplaint(\d+)$/)?.[1];
    if (index === undefined || await nameCell.getAttribute('id') !== `CompName${index}`) {
      throw new Error('Encounter HPI complaint name and checkbox do not identify the same row');
    }
    const idField = scope.locator(this.selectors.hpiEncounterComplaintIdField.replace('{index}', index));
    const complaintId = await idField.count() === 1 ? (await idField.inputValue()).trim() : '';
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(complaintId)
      || (expectedId !== undefined && complaintId !== expectedId)) {
      throw Object.assign(new Error('Encounter HPI complaint ID is missing or does not match the selected complaint'), {
        code: 'HPI_COMPLAINT_ID_INVALID'
      });
    }
    return { scope, nameCell, checkbox, complaintId };
  }

  async activateEncounterHpiComplaint(complaintName, expectedId) {
    const addedDeadline = Date.now() + (this.config.sectionLoadTimeoutMs ?? 10_000);
    let selected;
    do {
      selected = await this.findEncounterHpiComplaint(complaintName, expectedId);
      if (selected) break;
      // Lookup can close before the encounter frame has finished adding the row.
      await this.editorPage.waitForTimeout(100);
    } while (Date.now() < addedDeadline);
    if (!selected) throw new Error('Selected complaint is missing from the HPI encounter complaint list');
    const complaintId = selected.complaintId;
    const activeId = () => selected.scope.locator(this.selectors.hpiActiveComplaintId).inputValue();
    if (await activeId() !== complaintId) {
      // The checkbox only sets mbChiefCmp. The name cell activates the narrative.
      await selected.nameCell.click();
    }
    const deadline = Date.now() + (this.config.sectionLoadTimeoutMs ?? 10_000);
    let active = false;
    do {
      // Activation reloads HPI; reacquire the exact row instead of retaining its index.
      selected = await this.findEncounterHpiComplaint(complaintName, complaintId);
      if (selected && await activeId() === complaintId) {
        active = true;
        break;
      }
      await this.editorPage.waitForTimeout(100);
    } while (Date.now() < deadline);
    if (!active) {
      throw Object.assign(new Error('Exact encounter HPI complaint did not become active'), {
        code: 'HPI_COMPLAINT_NOT_ACTIVE'
      });
    }
    // Set the demonstrated chief-complaint checkbox without toggling other rows.
    await selected.checkbox.check();
    this.assertNoUnexpectedDialog();
    this.selectedHpiComplaintName = complaintName;
    this.selectedHpiComplaintId = complaintId;
    await this.assertSelectedHpiComplaint();
    return complaintId;
  }

  async selectHpiComplaint(appointmentType) {
    const complaintName = this.config.hpiComplaintName
      ?? this.config.hpiComplaintByAppointmentType?.[appointmentType];
    if (!complaintName) {
      throw new Error('No exact HPI complaint mapping exists for this appointment type');
    }
    this.selectedHpiComplaintId = null;
    this.selectedHpiComplaintName = null;
    await this.dismissTransientOverlay();
    let complaintPage = null;
    for (const candidate of [...this.editorPage.context().pages()].reverse()) {
      if (candidate.isClosed()) continue;
      if (this.config.url) {
        try {
          if (new URL(candidate.url()).origin !== new URL(this.config.url).origin) continue;
        } catch { continue; }
      }
      if (await optionalVisibleInFrames(candidate, this.selectors.hpiComplaintSearchInput)) {
        complaintPage = candidate;
        break;
      }
    }
    if (!complaintPage) {
      // HPI navigation alone does not open the complaint-selection popup.
      await clickInFrames(
        this.editorPage, this.selectors.hpiMenu,
        'PrognoCIS HPI menu before complaint selection',
        { allowHiddenLegacy: true, timeout: this.config.sectionLoadTimeoutMs ?? 20_000 }
      );
      const lookup = await firstVisibleInSectionFrame(
        this.editorPage, this.selectors.hpiComplaintLookupButton,
        this.config.sectionUrlPatterns?.hpi, 'HPI binocular complaint lookup',
        this.config.sectionLoadTimeoutMs ?? 20_000
      );
      await lookup.scope.waitForLoadState('domcontentloaded', {
        timeout: this.config.sectionLoadTimeoutMs ?? 20_000
      });
      if (this.selectors.hpiEncounterComplaintRows
        && await this.findEncounterHpiComplaint(complaintName)) {
        return this.activateEncounterHpiComplaint(complaintName);
      }
      await lookup.locator.click();
      complaintPage = await contextPageWithVisibleSelector(
        this.editorPage, this.selectors.hpiComplaintSearchInput,
        'HPI complaint search', this.config.popupTimeoutMs
      );
    }
    this.watchDialogs(complaintPage);
    const search = await firstVisibleInFrames(
      complaintPage,
      this.selectors.hpiComplaintSearchInput,
      'HPI complaint search',
      this.config.popupTimeoutMs
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
      'HPI complaint results',
      this.config.patientSearchTimeoutMs ?? 10_000
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
    const rawComplaintId = await exact.getAttribute(this.config.hpiComplaintIdAttribute);
    const complaintId = stableEncounterId(rawComplaintId, this.config.hpiComplaintIdPattern);
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(complaintId)) {
      const error = new Error('Exact HPI complaint result did not expose a stable complaint ID');
      error.code = 'HPI_COMPLAINT_ID_INVALID';
      throw error;
    }
    const closes = complaintPage !== this.editorPage
      ? complaintPage.waitForEvent('close', { timeout: this.config.popupTimeoutMs }).catch(() => null)
      : null;
    // An unchecked lookup checkbox does not mean the active complaint is absent
    // from the encounter. Re-adding it can replace that complaint's saved notes.
    const existingComplaint = this.selectors.hpiEncounterComplaintRows
      ? await this.findEncounterHpiComplaint(complaintName, complaintId)
      : null;
    if (existingComplaint && !this.selectors.hpiComplaintCloseButton) {
      throw new Error('Existing HPI complaint must be preserved; configure the complaint lookup close control');
    }
    if (this.selectors.hpiComplaintCloseButton
      && (existingComplaint
        || await valueInFrames(this.editorPage, this.selectors.hpiActiveComplaintId) === complaintId)) {
      await clickInFrames(complaintPage, this.selectors.hpiComplaintCloseButton,
        'close lookup for already-active HPI complaint', { retryOnTransient: false })
        .catch(error => { if (!complaintPage.isClosed()) throw error; });
      if (closes && !(await closes)) throw new Error('HPI complaint lookup did not close');
      if (this.selectors.hpiEncounterComplaintRows) {
        return this.activateEncounterHpiComplaint(complaintName, complaintId);
      }
      await requireValueInFrames(this.editorPage, this.selectors.hpiActiveComplaintId,
        complaintId, 'PrognoCIS existing HPI complaint', this.config.sectionLoadTimeoutMs ?? 10_000);
      this.selectedHpiComplaintId = complaintId;
      return;
    }
    if (this.selectors.hpiComplaintSelectButton) {
      // check() is state-setting, unlike click(), which can uncheck an existing
      // selection. Always ensure the exact row is selected before confirming,
      // even if its complaint ID was already active in the HPI editor.
      await exact.locator(this.selectors.hpiComplaintSelectButton).first().check();
    } else {
      await exact.click();
    }
    if (this.selectors.hpiComplaintConfirmButton) {
      await clickInFrames(
        complaintPage,
        this.selectors.hpiComplaintConfirmButton,
        'confirm HPI complaint',
        { retryOnTransient: false }
      );
    }
    if (complaintPage !== this.editorPage && !complaintPage.isClosed() && !(await closes)) {
      throw new Error('PrognoCIS HPI complaint search did not close after exact selection');
    }
    if (this.selectors.hpiEncounterComplaintRows) {
      return this.activateEncounterHpiComplaint(complaintName, complaintId);
    }
    await requireValueInFrames(
      this.editorPage,
      this.selectors.hpiActiveComplaintId,
      complaintId,
      'PrognoCIS HPI complaint',
      this.config.sectionLoadTimeoutMs ?? 10_000
    );
    this.assertNoUnexpectedDialog();
    this.selectedHpiComplaintId = complaintId;
    return complaintId;
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

  async readSection(section, appointmentType, options = {}) {
    // Open once. Recover only reads: repeating a menu click can start another
    // navigation or trigger a legacy auto-save.
    let field = await this.sectionField(section, appointmentType, options);
    const deadline = Date.now() + (this.config.sectionLoadTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      try {
        if (!field) {
          const fresh = await firstVisibleInSectionFrame(
            this.editorPage,
            this.selectors[`${section}Field`],
            this.config.sectionUrlPatterns?.[section],
            `PrognoCIS ${section} narrative field after frame reload`,
            Math.max(1, deadline - Date.now())
          );
          await fresh.scope.waitForLoadState('domcontentloaded', {
            timeout: Math.max(1, deadline - Date.now())
          });
          field = fresh.locator;
        }
        return await readField(field, { timeout: Math.max(1, deadline - Date.now()) });
      } catch (error) {
        if (this.editorPage.isClosed()
          || !/execution context was destroyed|cannot find context|frame (?:was|has been) detached|frame has been detached|target page, context or browser has been closed/i.test(error.message)) {
          throw error;
        }
        field = null;
        if (Date.now() >= deadline) break;
        await this.editorPage.waitForTimeout(Math.min(100, deadline - Date.now()));
      }
    }
    throw Object.assign(new Error(`PrognoCIS ${section} frame did not stabilize for note inspection`), {
      code: 'CLINICAL_SECTION_READ_UNSTABLE'
    });
  }

  async readSections(artifact, options = {}) {
    const values = {};
    for (const section of SECTION_NAMES) {
      values[section] = await this.readSection(section, artifact.encounter.appointmentType, options);
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
      if (section === 'hpi') {
        await this.assertSelectedHpiComplaint();
      }
      await fillField(field, artifact.sections[section]);
      if (normalizeClinicalText(await readField(field)) !== normalizeClinicalText(artifact.sections[section])) {
        throw new Error(`PrognoCIS ${section} field did not retain the approved text before save`);
      }
      if (section === 'hpi') await this.assertSelectedHpiComplaint();
      const save = await firstVisibleInSectionFrame(
        this.editorPage, this.selectors[`${section}SaveButton`],
        this.config.sectionUrlPatterns?.[section], `PrognoCIS ${section} Save`,
        this.config.sectionLoadTimeoutMs ?? 10_000
      );
      await waitForConfiguredSave(this.editorPage, {
        urlPattern: this.config.sectionSaveUrlPatterns?.[section] ?? this.config.sectionSaveUrlPattern,
        successSelector: this.selectors.sectionSaveSuccess,
        timeoutMs: this.config.saveTimeoutMs ?? 90_000,
        label: `PrognoCIS ${section} save`
      }, () => save.locator.click());
      this.assertNoUnexpectedDialog();
    }
  }

  async assertSelectedHpiComplaint() {
    if (!this.selectedHpiComplaintId) {
      throw Object.assign(new Error('HPI complaint must be selected and verified before entering or saving the note'), {
        code: 'HPI_COMPLAINT_NOT_ACTIVE'
      });
    }
    if (this.selectors.hpiEncounterComplaintRows) {
      const selected = await this.findEncounterHpiComplaint(
        this.selectedHpiComplaintName, this.selectedHpiComplaintId
      );
      if (!selected
        || await selected.scope.locator(this.selectors.hpiActiveComplaintId).inputValue() !== this.selectedHpiComplaintId) {
        throw Object.assign(new Error('The exact selected encounter HPI complaint is no longer active'), {
          code: 'HPI_COMPLAINT_NOT_ACTIVE'
        });
      }
      if (!(await selected.checkbox.isChecked())) {
        throw Object.assign(new Error('The exact selected encounter HPI complaint checkbox is not checked'), {
          code: 'HPI_COMPLAINT_NOT_CHECKED'
        });
      }
      return;
    }
    await requireValueInFrames(
      this.editorPage,
      this.selectors.hpiActiveComplaintId,
      this.selectedHpiComplaintId,
      'PrognoCIS selected HPI complaint',
      this.config.sectionLoadTimeoutMs ?? 10_000
    );
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
    // The production narrative-only flow saves each section individually.
    // It never visits Assessment or requires another encounter-save action.
    if (this.config.draftSaveStrategy !== 'sections-only') {
      const save = await firstVisibleInSectionFrame(
        this.editorPage, this.selectors.saveDraftButton,
        this.config.draftSaveFrameUrlPattern, 'PrognoCIS Save Draft',
        this.config.sectionLoadTimeoutMs ?? 10_000
      );
      await waitForConfiguredSave(this.editorPage, {
        urlPattern: this.config.draftSaveUrlPattern,
        successSelector: this.selectors.draftSaveSuccess,
        timeoutMs: this.config.saveTimeoutMs ?? 90_000,
        label: 'PrognoCIS draft save'
      }, () => save.locator.click());
    }
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
    await this.selectHpiComplaint(artifact.encounter.appointmentType);
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
    await this.selectHpiComplaint(artifact.encounter.appointmentType);
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
