// Minimal W3C WebDriver client for tauri-driver (local HTTP only; no npm dependencies) and helpers
// shared by the desktop runs against the real build (tauri-smoke.mjs, station-host.mjs).
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timeout: ${label}${last ? ` (${last.message})` : ''}`);
    await sleep(250);
  }
}

function newest(dir, prefix, rel) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .pop();
  return hit ? join(dir, hit, rel) : null;
}

/** tauri-driver and msedgedriver from the command line or %LOCALAPPDATA%\skepi\tools. */
export function driverPaths(tauriDriver, edgeDriver) {
  const tools = join(process.env.LOCALAPPDATA ?? '', 'skepi', 'tools');
  const t = tauriDriver ?? newest(tools, 'tauri-driver-', join('bin', 'tauri-driver.exe'));
  const e = edgeDriver ?? newest(tools, 'msedgedriver-', 'msedgedriver.exe');
  if (!t || !e) throw new Error('tauri-driver or msedgedriver not found');
  return { tauriDriver: t, edgeDriver: e };
}

/** The same browser arguments as src-tauri/src/commands.rs BROWSER_ARGS: msedgedriver replaces the app's, so they are passed
 * again as WebView2 options (ms:edgeOptions.webviewOptions.additionalBrowserArguments, a list). */
export const BROWSER_ARGS = [
  '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msOneAuthWAM,msLoadOneAuthInBackground,msEdgeOSAccountInfoSubstrate',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--no-pings',
  '--dns-prefetch-disable',
];

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class Driver {
  constructor({ tauriDriver, edgeDriver, env, port = 4444 }) {
    this.base = `http://127.0.0.1:${String(port)}`;
    this.proc = spawn(tauriDriver, ['--native-driver', edgeDriver, '--port', String(port)], { env: { ...process.env, ...env }, stdio: 'ignore' });
    this.session = '';
  }

  async wd(method, path, body) {
    const res = await fetch(`${this.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
    return json.value;
  }

  async open(app) {
    await waitFor(() => fetch(`${this.base}/status`).then((r) => r.ok), 20_000, 'tauri-driver');
    const value = await this.wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: resolve(app), webviewOptions: { additionalBrowserArguments: BROWSER_ARGS } } } } });
    this.session = value.sessionId;
    this.main = await this.wd('GET', `/session/${this.session}/window`);
    return this;
  }

  s(path) {
    return `/session/${this.session}${path}`;
  }

  async find(css) {
    return (await this.wd('POST', this.s('/element'), { using: 'css selector', value: css }))[ELEMENT];
  }

  async findAll(css) {
    return (await this.wd('POST', this.s('/elements'), { using: 'css selector', value: css })).map((e) => e[ELEMENT]);
  }

  async click(css) {
    return this.wd('POST', this.s(`/element/${await this.find(css)}/click`), {});
  }

  async clear(css) {
    return this.wd('POST', this.s(`/element/${await this.find(css)}/clear`), {});
  }

  async type(css, text) {
    return this.wd('POST', this.s(`/element/${await this.find(css)}/value`), { text });
  }

  async text(css) {
    return this.wd('GET', this.s(`/element/${await this.find(css)}/text`));
  }

  async selectValue(css, value) {
    return this.runInPage(
      `const [sel, v] = arguments; const el = document.querySelector(sel); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('change', { bubbles: true })); arguments[arguments.length - 1](el.value);`,
      [css, value],
    );
  }

  runInPage(script, args = []) {
    return this.wd('POST', this.s('/execute/async'), { script, args });
  }

  async visible(testId) {
    return (await this.findAll(`[data-testid="${testId}"]`)).length > 0;
  }

  async screenshot(file) {
    const png = await this.wd('GET', this.s('/screenshot'));
    writeFileSync(file, Buffer.from(png, 'base64'));
  }

  async close() {
    if (this.session) await this.wd('DELETE', this.s('')).catch(() => undefined);
    this.session = '';
  }

  kill() {
    this.proc.kill();
  }
}

export const tid = (id) => `[data-testid="${id}"]`;
