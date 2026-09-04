export class AuthenticationRequiredError extends Error {
  constructor() {
    super('PrognoCIS authentication is required in the persistent remote browser');
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
  const attempts = pageScopes(page).map(async (scope) => ({
    scope,
    locator: await firstVisible(scope, selector, label, timeout)
  }));
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error(`Visible element not found in any frame for ${label}`);
  }
}

export async function optionalVisibleInFrames(page, selector) {
  if (!selector) return null;
  for (const scope of pageScopes(page)) {
    const locator = scope.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return { scope, locator };
  }
  return null;
}

export async function clickInFrames(page, selector, label, { allowHiddenLegacy = false } = {}) {
  const visible = await optionalVisibleInFrames(page, selector);
  if (visible) {
    await visible.locator.click();
    return visible;
  }
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

export async function readField(locator) {
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (['input', 'textarea', 'select'].includes(tagName)) return locator.inputValue();
  if (await locator.getAttribute('contenteditable') === 'true') return locator.innerText();
  return locator.textContent();
}

export async function fillField(locator, value) {
  await locator.click();
  await locator.fill(value);
  await locator.dispatchEvent('input');
  await locator.dispatchEvent('change');
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

