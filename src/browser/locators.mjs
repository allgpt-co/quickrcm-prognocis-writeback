export class AuthenticationRequiredError extends Error {
  constructor(platform = 'PrognoCIS') {
    super(`${platform} authentication is required in the persistent remote browser`);
    this.name = 'AuthenticationRequiredError';
    this.code = 'AUTH_REQUIRED';
  }
}

export function pageScopes(page) {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

export async function firstVisible(scope, selector, label, timeout = 20_000) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error(`No selector configured for ${label}`);
  }
  try {
    const locator = scope.locator(selector).first();
    await locator.waitFor({ state: 'visible', timeout });
    return locator;
  } catch {
    throw new Error(`Visible element not found for ${label}`);
  }
}

export async function firstVisibleInFrames(page, selector, label, timeout = 20_000) {
  if (typeof selector !== 'string' || !selector.trim()) {
    throw new Error(`No selector configured for ${label}`);
  }
  const deadline = Date.now() + timeout;
  do {
    for (const scope of pageScopes(page)) {
      try {
        const locator = scope.locator(selector).first();
        if (await locator.isVisible().catch(() => false)) return { scope, locator };
      } catch {
        // A legacy frameset may replace its frames while a patient or encounter is selected.
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  throw new Error(`Visible element not found in any frame for ${label}`);
}

export async function optionalVisibleInFrames(page, selector) {
  if (!selector) return null;
  for (const scope of pageScopes(page)) {
    const matches = scope.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = matches.nth(index);
      if (await locator.isVisible().catch(() => false)) return { scope, locator };
    }
  }
  return null;
}

export async function clickInFrames(
  page,
  selector,
  label,
  { allowHiddenLegacy = false, retryOnTransient = true, timeout = 20_000 } = {}
) {
  const deadline = Date.now() + timeout;
  do {
    const visible = await optionalVisibleInFrames(page, selector);
    if (visible) {
      try {
        await visible.locator.click();
        return visible;
      } catch (error) {
        if (!retryOnTransient
          || !/context|detach|closed|destroyed/i.test(error.message)
          || Date.now() >= deadline) {
          throw error;
        }
      }
    }
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  if (allowHiddenLegacy) {
    for (const scope of pageScopes(page)) {
      const locator = scope.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        await locator.evaluate((element) => element.click());
        return { scope, locator };
      }
    }
  }
  throw new Error(`Visible element not found in any frame for ${label}`);
}

export async function readField(locator, { timeout } = {}) {
  // Read type and content in one browser evaluation, not across a frame reload.
  return locator.evaluate((element) => {
    const tagName = element.tagName.toLowerCase();
    if (['input', 'textarea', 'select'].includes(tagName)) return element.value;
    if (element.getAttribute('contenteditable') === 'true') return element.innerText;
    return element.textContent;
  }, undefined, { timeout });
}

export async function fillField(locator, value) {
  await locator.click();
  await locator.fill(value);
  await locator.dispatchEvent('input');
  await locator.dispatchEvent('change');
}

export async function fillCredentialField(locator, value, platform) {
  try {
    await fillField(locator, value);
  } catch {
    const error = new AuthenticationRequiredError(platform);
    error.message = `${platform} credential entry failed`;
    throw error;
  }
}

export async function visibleTextsInFrames(page, selector) {
  const values = [];
  for (const scope of pageScopes(page)) {
    const rows = scope.locator(selector);
    const count = await rows.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (await row.isVisible().catch(() => false)) values.push(await row.innerText().catch(() => ''));
    }
  }
  return values;
}
