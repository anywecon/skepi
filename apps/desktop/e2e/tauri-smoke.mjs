// tauri-driver smoke run against the real Windows build (no mocks): libzim search and articles, the
// sealed viewer (scripts off, no IPC, CSP, external links as text), Layer 1 + AI summary on the GPU,
// the offline map through the maps protocol, places search, and zero egress from the app's processes.
//
//   node apps/desktop/e2e/tauri-smoke.mjs --app target/debug/skepi-desktop.exe --content <folder>
//
// Needs tauri-driver (cargo install tauri-driver) and the msedgedriver matching the WebView2 runtime
// (paths: --tauri-driver, --edge-driver, or %LOCALAPPDATA%\skepi\tools\...). WebDriver is spoken over
// plain HTTP here (local only), so the smoke run has no npm dependencies.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const { values: args } = parseArgs({
  options: {
    app: { type: 'string', default: join(REPO, 'target', 'debug', 'skepi-desktop.exe') },
    content: { type: 'string', default: join(process.env.LOCALAPPDATA ?? '', 'skepi', 'e2e-desktop', 'content') },
    'tauri-driver': { type: 'string' },
    'edge-driver': { type: 'string' },
    out: { type: 'string', default: join(REPO, 'e2e', 'out', 'desktop-smoke') },
  },
});

function newest(dir, prefix, rel) {
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir)
    .filter((d) => d.startsWith(prefix))
    .sort()
    .pop();
  return hit ? join(dir, hit, rel) : null;
}
const tools = join(process.env.LOCALAPPDATA ?? '', 'skepi', 'tools');
const tauriDriver = args['tauri-driver'] ?? newest(tools, 'tauri-driver-', join('bin', 'tauri-driver.exe'));
const edgeDriver = args['edge-driver'] ?? newest(tools, 'msedgedriver-', 'msedgedriver.exe');
if (!tauriDriver || !edgeDriver) throw new Error('tauri-driver or msedgedriver not found');
mkdirSync(args.out, { recursive: true });
rmSync(join(args.out, 'webview-netlog.json'), { force: true });
const appData = mkdtempSync(join(tmpdir(), 'skepi-smoke-'));
const results = [];
const PORT = 4444;
const WD = `http://127.0.0.1:${PORT}`;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
}

async function wd(method, path, body) {
  const res = await fetch(`${WD}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json.value ?? json).slice(0, 300)}`);
  return json.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, label) {
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

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';
let S = '';
const find = async (css) => (await wd('POST', `/session/${S}/element`, { using: 'css selector', value: css }))[ELEMENT];
const findAll = async (css) => (await wd('POST', `/session/${S}/elements`, { using: 'css selector', value: css })).map((e) => e[ELEMENT]);
const click = async (css) => wd('POST', `/session/${S}/element/${await find(css)}/click`, {});
const clear = async (css) => wd('POST', `/session/${S}/element/${await find(css)}/clear`, {});
const type = async (css, text) => wd('POST', `/session/${S}/element/${await find(css)}/value`, { text });
const textOf = async (css) => wd('GET', `/session/${S}/element/${await find(css)}/text`);
const runInPage = (script, a = []) => wd('POST', `/session/${S}/execute/async`, { script, args: a });
const tid = (id) => `[data-testid="${id}"]`;
const visible = (id) => findAll(tid(id)).then((l) => l.length > 0);
const ENTER = '';
// msedgedriver hands these to WebView2 instead of the app's own additionalBrowserArgs: the same list
// as src-tauri/src/commands.rs BROWSER_ARGS, so the egress check sees the app's real configuration.
const NETLOG = resolve(args.out, 'webview-netlog.json');
const BROWSER_ARGS = [
  '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msOneAuthWAM,msLoadOneAuthInBackground,msEdgeOSAccountInfoSubstrate',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--no-pings',
];

async function screenshot(name) {
  const png = await wd('GET', `/session/${S}/screenshot`);
  writeFileSync(join(args.out, `${name}.png`), Buffer.from(png, 'base64'));
}

/** TCP connections to anything but loopback: the app process itself, and its WebView2 runtime processes. */
function remoteConnections() {
  const ps = `
$root = Get-CimInstance Win32_Process -Filter "Name='skepi-desktop.exe'" | Select-Object -First 1
if (-not $root) { '[]'; exit }
$all = Get-CimInstance Win32_Process
$ids = @($root.ProcessId); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if ($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
@(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') } | ForEach-Object { $c = $_; [pscustomobject]@{ Process = ($all | Where-Object { $_.ProcessId -eq $c.OwningProcess }).Name; RemoteAddress = $c.RemoteAddress; RemotePort = $c.RemotePort } }) | ConvertTo-Json -Compress`;
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', env: { ...process.env, PSModulePath: '' } }).trim();
  if (!out || out === '[]') return [];
  const v = JSON.parse(out);
  return Array.isArray(v) ? v : [v];
}

const egress = [];
/** Developer Preview build (label on home), set after start. */
let preview;
let samples = 0;
const sampleEgress = () => {
  try {
    egress.push(...remoteConnections());
    samples += 1;
  } catch (e) {
    console.log(`egress sample failed: ${e.message}`);
  }
};

/**
 * Direct start (no WebDriver, which replaces WebView2's arguments): the app's own browser arguments
 * plus a Chromium net log of every request its webviews make while it starts, reconciles the content
 * folder, opens the archives and settles. Only the app's own origins may appear.
 */
async function startupNetLog() {
  const app = spawn(resolve(args.app), [], {
    env: {
      ...process.env,
      SKEPI_CONTENT_ROOT: args.content,
      SKEPI_APP_DATA: mkdtempSync(join(tmpdir(), 'skepi-netlog-')),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [...BROWSER_ARGS, `--log-net-log=${NETLOG}`, '--net-log-capture-mode=Default'].join(' '),
    },
    stdio: 'ignore',
  });
  await sleep(25_000);
  sampleEgress();
  execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await sleep(2000);
}
await startupNetLog();

const driver = spawn(tauriDriver, ['--native-driver', edgeDriver, '--port', String(PORT)], {
  env: { ...process.env, SKEPI_CONTENT_ROOT: args.content, SKEPI_APP_DATA: appData },
  stdio: ['ignore', 'pipe', 'pipe'],
});
driver.stderr.on('data', () => undefined);
driver.stdout.on('data', () => undefined);

try {
  await waitFor(() => fetch(`${WD}/status`).then((r) => r.ok), 20_000, 'tauri-driver');
  S = (await wd('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: resolve(args.app), webviewOptions: { additionalBrowserArguments: BROWSER_ARGS } } } } })).sessionId;
  const main = await wd('GET', `/session/${S}/window`);

  await waitFor(() => visible('search-screen'), 60_000, 'app start');
  await waitFor(async () => (await findAll('.app[data-status="ready"]')).length > 0 && (await visible('disclaimer')), 600_000, 'reconcile + disclaimer');
  await click(tid('disclaimer-accept'));
  // Developer Preview builds (SKEPI_PREVIEW=1) show a permanent label on the home screen.
  preview = await visible('preview-label');
  check(`build mode: ${preview ? 'Developer Preview (label on home)' : 'full cards'}`, true);
  sampleEgress();

  // Library: the catalog packs were hashed and registered as verified; the sealing fixture is unverified.
  await click(tid('tab-library'));
  await waitFor(() => visible('installed-wikipedia_en_top_mini'), 30_000, 'library');
  check('reconcile registers catalog packs as verified', (await textOf(tid('installed-wikipedia_en_top_mini'))).includes('Verified'));
  check('unknown ZIM is listed unverified and needs consent', (await findAll('[data-testid^="consent-local-"]')).length === 1);
  await click('[data-testid^="consent-local-"]');
  await click(tid('consent-accept'));
  await waitFor(async () => (await findAll('[data-testid^="consent-local-"]')).length === 0, 10_000, 'consent');

  // Search through libzim: suggestions and full text.
  await click(tid('tab-search'));
  await type(tid('search-input'), 'Canberra');
  await waitFor(() => visible('hit-Canberra'), 15_000, 'suggestion Canberra');
  check('title suggestions from libzim', true);
  await type(tid('search-input'), ENTER);
  await waitFor(async () => (await textOf(tid('search-timing'))).includes('fulltext'), 15_000, 'full text');
  check('full-text search from libzim', true, await textOf(tid('search-timing')));

  // The sealed viewer.
  await click(tid('hit-Canberra'));
  const viewer = await waitFor(async () => (await wd('GET', `/session/${S}/window/handles`)).find((h) => h !== main), 15_000, 'viewer window');
  await wd('POST', `/session/${S}/window`, { handle: viewer });
  const url = await wd('GET', `/session/${S}/url`);
  check('article opens in the separate viewer on zim://', url.startsWith('http://zim.localhost/'), url);
  await screenshot('viewer-canberra');

  // Sealing fixture: inline script, external images, iframe and links.
  await wd('POST', `/session/${S}/window`, { handle: main });
  await clear(tid('search-input'));
  await type(tid('search-input'), 'Sealing');
  await waitFor(() => visible('hit-index'), 15_000, 'sealing fixture hit');
  await click(tid('hit-index'));
  await wd('POST', `/session/${S}/window`, { handle: viewer });
  await waitFor(async () => (await wd('GET', `/session/${S}/url`)).includes('/index'), 15_000, 'fixture navigation');
  const title = await wd('GET', `/session/${S}/title`);
  check('inline scripts do not run (title not "pwned")', title === 'Sealing fixture', title);
  const probe = await runInPage(`
    const done = arguments[arguments.length - 1];
    const out = { internals: typeof window.__TAURI_INTERNALS__, local: 0, external: [] };
    const local = document.getElementById('local');
    out.local = local ? local.naturalWidth : -1;
    out.external = Array.from(document.images).filter((i) => i.id !== 'local').map((i) => i.naturalWidth);
    out.csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? null;
    const tries = [];
    if (window.__TAURI_INTERNALS__) {
      tries.push(window.__TAURI_INTERNALS__.invoke('zim_search', { query: 'water', limit: 5, archiveIds: null, withSnippets: false }).then(() => 'IPC ALLOWED', (e) => 'ipc denied: ' + String(e)));
    } else tries.push(Promise.resolve('no IPC object'));
    tries.push(fetch('http://ipc.localhost/zim_search', { method: 'POST', body: '{}' }).then(() => 'FETCH ALLOWED', (e) => 'fetch blocked: ' + String(e)));
    tries.push(fetch('https://example.invalid/').then(() => 'NETWORK ALLOWED', (e) => 'network blocked: ' + String(e)));
    Promise.all(tries).then((r) => { out.tries = r; done(out); });
  `).catch((e) => ({ error: e.message }));
  writeFileSync(join(args.out, 'viewer-probe.json'), JSON.stringify(probe, null, 2));
  if (probe.error) {
    check('viewer probe ran (host-injected script)', false, probe.error);
  } else {
    check('local image served through zim:// under the CSP', probe.local > 0, JSON.stringify(probe.local));
    check('external images blocked (http/https/file/content)', probe.external.every((w) => w === 0), JSON.stringify(probe.external));
    check('CSP meta present in the document', typeof probe.csp === 'string' && probe.csp.includes("default-src 'none'"), probe.csp);
    check('article content cannot reach Tauri IPC', probe.tries.every((t) => !t.includes('ALLOWED')), JSON.stringify(probe.tries));
  }
  await screenshot('viewer-sealing-fixture');
  await click('#http');
  await sleep(1500);
  check('external link navigation cancelled (viewer stays on zim://)', (await wd('GET', `/session/${S}/url`)).startsWith('http://zim.localhost/'));
  await wd('POST', `/session/${S}/window`, { handle: main });
  await waitFor(async () => (await textOf(tid('external-links'))).includes('example.invalid'), 10_000, 'external link banner');
  check('external link shown as text in the main window', true, await textOf(tid('external-links')));
  sampleEgress();

  // Ask: Layer 1, then the AI summary with a verified citation (T3 on the GPU).
  await click(tid('tab-ask'));
  await type(tid('ask-input'), 'What is the capital of Australia?');
  await click(tid('ask-submit'));
  await waitFor(() => visible('layer1'), 30_000, 'Layer 1');
  check('Layer 1 extractive answer', true);
  await waitFor(async () => (await textOf(tid('ask-phase'))) === 'done', 180_000, 'AI summary');
  const metrics = await textOf(tid('ask-metrics'));
  writeFileSync(join(args.out, 'ask-metrics.txt'), metrics);
  const sentences = await findAll('[data-testid^="answer-sentence-"]');
  const citations = await findAll('[data-testid^="citation-S"]');
  check('AI summary with verified citations', sentences.length > 0 && citations.length > 0, metrics);
  check('inference ran on the GPU (Vulkan)', /gpu=(?!no)/.test(metrics), metrics);
  await screenshot('ask');
  sampleEgress();

  // Places and the offline map.
  await click(tid('tab-search'));
  await clear(tid('search-input'));
  await type(tid('search-input'), 'Patras');
  await waitFor(async () => (await findAll('[data-testid^="place-"]')).length > 0, 15_000, 'place search');
  check('place search from the places pack', true);
  await click('[data-testid^="place-"]');
  await waitFor(async () => (await textOf(tid('map-status'))).includes('offline PMTiles'), 60_000, 'map');
  await sleep(3000);
  check('map renders from the verified PMTiles pack (maps protocol)', true, await textOf(tid('map-status')));
  check('emergency POIs from the places pack', /\d+ emergency point/.test(await textOf(tid('poi-count'))), await textOf(tid('poi-count')));
  await screenshot('map');
  // The focus layer of the place, then pan and zoom with real input: the worker keeps drawing (same-origin worker, CSP).
  check('focused place is named on the map', (await textOf(tid('map-focus'))).length > 0, await textOf(tid('map-focus')));
  const mapElement = await find(tid('map'));
  const mapPixels = async () => wd('GET', `/session/${S}/element/${mapElement}/screenshot`);
  const before = await mapPixels();
  await wd('POST', `/session/${S}/actions`, {
    actions: [
      {
        type: 'pointer',
        id: 'mouse',
        parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', duration: 0, origin: { [ELEMENT]: mapElement }, x: 0, y: 0 },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerMove', duration: 300, origin: 'pointer', x: -160, y: -90 },
          { type: 'pointerUp', button: 0 },
        ],
      },
    ],
  });
  await sleep(2500);
  const panned = await mapPixels();
  check('map pans with the mouse', panned !== before);
  await screenshot('map-panned');
  await click('.maplibregl-ctrl-zoom-in');
  await click('.maplibregl-ctrl-zoom-in');
  await sleep(2500);
  const zoomedIn = await mapPixels();
  check('map zooms in', zoomedIn !== panned);
  await screenshot('map-zoomed-in');
  await click('.maplibregl-ctrl-zoom-out');
  await click('.maplibregl-ctrl-zoom-out');
  await click('.maplibregl-ctrl-zoom-out');
  await click('.maplibregl-ctrl-zoom-out');
  await sleep(2500);
  check('map zooms out', (await mapPixels()) !== zoomedIn);
  await screenshot('map-zoomed-out');
  check('no map error after pan and zoom', !(await visible('map-error')) && (await textOf(tid('map-status'))).includes('offline PMTiles'), await textOf(tid('map-status')));
  sampleEgress();

  // Emergency question: the country number before any Layer 1 excerpt.
  await click(tid('tab-ask'));
  await clear(tid('ask-input'));
  await type(tid('ask-input'), 'What should I do in an earthquake?');
  await click(tid('ask-submit'));
  const order = await waitFor(
    async () =>
      wd('POST', `/session/${S}/execute/sync`, {
        script:
          "const l=document.querySelector('[data-testid=\"layer1\"]'); if(!l) return null; const b=document.querySelector('[data-testid=\"emergency-banner\"]'); return { banner: b ? b.textContent : null, before: b ? Boolean(b.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) : false };",
        args: [],
      }),
    60_000,
    'Layer 1 for the emergency question',
  );
  check('emergency question: country number shown before any Layer 1 excerpt', order.before === true && /Call 112/.test(order.banner ?? ''), JSON.stringify(order));
  await waitFor(() => visible('summary-emergency'), 60_000, 'no-AI notice for the emergency question');
  check(
    'emergency question: no AI summary and no AI button',
    !(await visible('ask-summarise')) && (await findAll('[data-testid="ai-summary"]')).length === 0,
  );
  await click(tid('ask-clear'));

  await click(tid('emergency-button'));
  await click(tid('card-open-cpr'));
  check(
    'emergency card: "Call 112 first", IFRC steps and their citation',
    (await visible('card-call-first')) && (await visible('card-step-1')) && (await textOf(tid('card-citation'))).includes('IFRC International First Aid, Resuscitation and Education Guidelines 2025'),
  );

  await click(tid('tab-about'));
  await waitFor(() => visible('about-screen'), 10_000, 'about');
  const about = await textOf(tid('about-screen'));
  check('About: version, GPL-3.0-or-later, notices, signing fingerprint, privacy', /Version \d+\.\d+\.\d+/.test(about) && about.includes('GPL-3.0-or-later') && /\d+ components/.test(about) && about.includes('7d61c382') && about.includes('telemetry'));
  if (preview) check('About carries the Developer Preview label', await visible('preview-label'));
  sampleEgress();
} catch (e) {
  check('smoke run completed', false, e.message);
  try {
    await screenshot('failure');
  } catch {
    // no session
  }
} finally {
  if (S) await wd('DELETE', `/session/${S}`).catch(() => undefined);
  driver.kill();
}

const appEgress = egress.filter((c) => c.Process === 'skepi-desktop.exe');
check('zero egress from the app process (Rust: no connection outside loopback)', samples > 0 && appEgress.length === 0, `${String(samples)} samples, ${JSON.stringify(appEgress)}`);
// Every URL any SKEPI webview requested: only the app's own origins (tauri, ipc, zim, maps).
/** URLs in a Chromium net log; a log cut off by the app exit lacks its closing `]}`. */
function netLogUrls(path) {
  try {
    const raw = readFileSync(path, 'utf8').trimEnd();
    const text = raw.endsWith(']}') ? raw : `${raw.replace(/,$/, '')}]}`;
    const log = JSON.parse(text);
    return [...new Set((log.events ?? []).map((e) => e.params?.url).filter((u) => typeof u === 'string'))];
  } catch (e) {
    return [`unreadable net log: ${e.message}`];
  }
}
const urls = netLogUrls(NETLOG);
const LOCAL = /^(http:\/\/(tauri|ipc|zim|maps)\.localhost\/|data:|blob:)/;
const remote = urls.filter((u) => !LOCAL.test(u));
check('zero egress from the webviews at startup (net log: only tauri/ipc/zim/maps.localhost)', urls.length > 0 && remote.length === 0, `${String(urls.length)} URLs; remote: ${JSON.stringify(remote)}`);
// The WebView2 runtime itself (Microsoft) may open a connection outside the pages' network stack;
// reported, not attributable to app content (docs/threat-model.md, "Desktop").
const runtime = [...new Set(egress.filter((c) => c.Process !== 'skepi-desktop.exe').map((c) => `${c.Process} ${c.RemoteAddress}:${String(c.RemotePort)}`))];
console.log(`WebView2 runtime connections (reported): ${JSON.stringify(runtime)}`);
writeFileSync(join(args.out, 'results.json'), JSON.stringify({ app: args.app, content: args.content, results, egress, samples, webviewUrls: urls, runtimeConnections: runtime }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? `DESKTOP SMOKE PASS (${String(results.length)} checks)` : `DESKTOP SMOKE FAIL (${String(failed.length)}/${String(results.length)})`);
process.exit(failed.length === 0 ? 0 : 1);
