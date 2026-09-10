import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ensurePrivateDirectory } from '../runtime/private-files.mjs';

const attached = new WeakMap();

async function isExecutable(file) {
  try {
    await fs.access(file, 0o1);
    return true;
  } catch {
    return false;
  }
}

export async function resolveChromiumExecutable(config) {
  if (config.executablePath) {
    const explicit = path.resolve(config.projectRoot, config.executablePath);
    return await isExecutable(explicit) ? explicit : null;
  }
  const bundled = chromium.executablePath();
  if (await isExecutable(bundled)) return bundled;
  for (const candidate of [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]) {
    if (await isExecutable(candidate)) return candidate;
  }
  try {
    const entries = (await fs.readdir('/opt/ms-playwright', { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('chromium-'))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const entry of entries) {
      const candidate = path.join('/opt/ms-playwright', entry, 'chrome-linux64', 'chrome');
      if (await isExecutable(candidate)) return candidate;
    }
  } catch {
    // The shared Playwright browser cache is optional.
  }
  return null;
}

export async function closeStaleLoginTargets(cdpEndpoint, loginUrl) {
  if (!cdpEndpoint || !loginUrl) return 0;
  const endpoint = cdpEndpoint.replace(/\/$/, '');
  const login = new URL(loginUrl);
  const actionPath = login.pathname.replace(/\.jsp$/i, '.action2');
  const stalePaths = new Set([login.pathname, actionPath]);
  const listTargets = async () => {
    const response = await fetch(`${endpoint}/json/list`);
    if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
    return response.json();
  };
  const staleTargets = (await listTargets()).filter((target) => {
    if (target.type !== 'page' || !target.id) return false;
    try {
      const url = new URL(target.url);
      return url.origin === login.origin && stalePaths.has(url.pathname);
    } catch {
      return false;
    }
  });
  for (const target of staleTargets) {
    const response = await fetch(`${endpoint}/json/close/${encodeURIComponent(target.id)}`);
    if (!response.ok) throw new Error(`CDP target close returned HTTP ${response.status}`);
  }
  if (staleTargets.length === 0) return 0;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = (await listTargets()).some((target) => staleTargets.some(({ id }) => id === target.id));
    if (!remaining) return staleTargets.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Stale PrognoCIS login targets did not close before CDP attachment');
}

export async function openBrowser(config) {
  if (config.cdpEndpoint) {
    const browser = await chromium.connectOverCDP(config.cdpEndpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('The configured CDP Chrome has no browser context');
    context.setDefaultTimeout(config.actionTimeoutMs);
    context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    attached.set(context, { browser, initialPages: new Set(context.pages()) });
    return context;
  }

  await ensurePrivateDirectory(config.userDataDir);
  const executablePath = await resolveChromiumExecutable(config);
  if (!executablePath) {
    throw new Error('No Chromium executable found; install Playwright Chromium or set browser.executablePath');
  }
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    executablePath,
    headless: config.headless,
    viewport: { width: 1440, height: 1000 }
  });
  context.setDefaultTimeout(config.actionTimeoutMs);
  context.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  return context;
}

export async function closeBrowser(context) {
  const connection = attached.get(context);
  if (!connection) {
    await context.close();
    return;
  }
  for (const page of context.pages()) {
    if (!connection.initialPages.has(page)) await page.close().catch(() => {});
  }
  attached.delete(context);
  await connection.browser.close();
}

export async function portalPage(context, url) {
  const origin = new URL(url).origin;
  const existing = context.pages().find((candidate) => {
    try {
      return !candidate.isClosed() && new URL(candidate.url()).origin === origin;
    } catch {
      return false;
    }
  });
  if (existing) return existing;
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}
