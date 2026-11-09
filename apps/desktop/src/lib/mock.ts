/**
 * In-memory backend for the Playwright E2E of the desktop UI (`vite --mode e2e`; never in a Tauri
 * build: ipc.ts imports it only in that mode). It answers the same commands as src-tauri with a tiny
 * fixed corpus, a scripted model whose answer is copied from its source (so core's citation checks
 * pass), fixture places, and a recorder that the tests read (`window.__skepiMock`).
 */
import type { Backend, CatalogPackJson, ContentState, OpenArchive, PackRow, Row, Stream } from './ipc';

interface Article {
  path: string;
  title: string;
  sections: { heading: string; level: number; text: string }[];
}

const ARCHIVE = '0f2c3e4a-1b2c-4d5e-8f90-123456789abc';

const ARTICLES: Article[] = [
  {
    path: 'Canberra',
    title: 'Canberra',
    sections: [
      { heading: '', level: 1, text: 'Canberra is the capital city of Australia. It is located at the northern end of the Australian Capital Territory.' },
      { heading: 'History', level: 2, text: 'The site of Canberra was selected for the capital in 1908 as a compromise between Sydney and Melbourne.' },
    ],
  },
  {
    path: 'Water_purification',
    title: 'Water purification',
    sections: [
      { heading: '', level: 1, text: 'Water purification is the process of removing undesirable chemicals and contaminants from water.' },
      { heading: 'Boiling', level: 2, text: 'Boiling water for one minute kills most microorganisms that cause disease.' },
    ],
  },
  {
    path: 'Earthquake',
    title: 'Earthquake',
    sections: [
      {
        heading: '',
        level: 1,
        text:
          'An earthquake is the shaking of the surface of the Earth caused by a sudden release of energy in the lithosphere. ' +
          // A source phone number and address (Layer 1 flags the number and removes the address).
          'Earthquake shaking reports go to the quake desk on 555-0177 or quakes@desk.example.',
      },
    ],
  },
];

const SHA = (c: string): string => c.repeat(64);

const PACKS: PackRow[] = [
  { id: 'test-smoke-en', kind: 'zim', version: '2026-09', title: 'Smoke test articles', path: 'C:/content/zim/eval-smoke-en.zim', sizeBytes: 221833, sha256: SHA('a'), verified: true, catalogSeq: 3, license: 'CC-BY-SA-4.0', source: 'provisioned', consentAt: null, installedAt: 1, lastOpenedAt: null },
  { id: 'qwen2.5-1.5b-instruct-q4_0', kind: 'gguf', version: '2024-09', title: 'Qwen2.5 1.5B', path: 'C:/content/models/qwen2.5-1.5b-instruct-q4_0.gguf', sizeBytes: 1066227232, sha256: SHA('b'), verified: true, catalogSeq: 3, license: 'Apache-2.0', source: 'download', consentAt: null, installedAt: 1, lastOpenedAt: null },
  { id: 'map-gr', kind: 'pmtiles', version: '20261005', title: 'Greece map', path: 'C:/content/maps/map-gr.pmtiles', sizeBytes: 1463694, sha256: SHA('c'), verified: true, catalogSeq: 3, license: 'ODbL-1.0', source: 'provisioned', consentAt: null, installedAt: 1, lastOpenedAt: null },
  { id: 'places-gr', kind: 'places', version: '20261004', title: 'Greece places', path: 'C:/content/maps/places-gr.sqlite', sizeBytes: 5292032, sha256: SHA('d'), verified: true, catalogSeq: 3, license: 'ODbL-1.0', source: 'provisioned', consentAt: null, installedAt: 1, lastOpenedAt: null },
  { id: 'local-0123456789ab', kind: 'zim', version: 'unverified', title: 'imported.zim', path: 'C:/content/zim/import-0123.zim', sizeBytes: 1000, sha256: SHA('e'), verified: false, catalogSeq: null, license: null, source: 'import', consentAt: null, installedAt: 1, lastOpenedAt: null },
];

const CY = { iso2: 'CY', name: 'Cyprus', bbox: [32.2225, 34.5224, 34.642, 35.7405] as [number, number, number, number], center: [33.0842, 34.9133] as [number, number] };
const GR = { iso2: 'GR', name: 'Greece', bbox: [19.5766, 34.7666, 28.2898, 41.7996] as [number, number, number, number], center: [21.7257, 39.4928] as [number, number] };
const DE = { iso2: 'DE', name: 'Germany', bbox: [5.8039, 47.2213, 15.0715, 55.1147] as [number, number, number, number], center: [9.6783, 50.9617] as [number, number] };
// Two of Germany's six parts (catalog/regions/index.json).
const DE_BAVARIA = {
  ...DE,
  part: { id: 'bavaria', name: 'Bavaria, Thuringia', regions: ['Thuringia', 'Bavaria', 'Thüringen', 'Bayern'], bbox: [8.9301, 47.2246, 13.8665, 51.6874] as [number, number, number, number] },
};
const DE_HESSE = {
  ...DE,
  part: { id: 'hesse', name: 'Hesse, Rhineland-Palatinate', regions: ['Hesse', 'Rhineland-Palatinate', 'Hessen', 'Rheinland-Pfalz'], bbox: [6.0502, 48.9088, 10.28, 51.7047] as [number, number, number, number] },
};

/** A country map or places pack of a schema 2 catalog (global maps). */
const regional = (id: string, kind: 'pmtiles' | 'places', sizeBytes: number, region: NonNullable<CatalogPackJson['region']>, sha: string): CatalogPackJson => ({
  id,
  kind,
  version: '2026-10-22',
  file: `${id}-20261022.${kind === 'pmtiles' ? 'pmtiles' : 'sqlite'}`,
  title: { en: `${kind === 'pmtiles' ? 'Map' : 'Places and emergency points'}: ${region.name}` },
  lang: ['en'],
  sizeBytes,
  sha256: SHA(sha),
  chunkSize: 67108864,
  chunkSha256: [SHA(sha)],
  urls: [`https://github.com/Fiouri/skepi/releases/download/packs-20261022/${id}-20261022`],
  license: 'ODbL-1.0',
  attribution: '© OpenStreetMap contributors',
  minTier: 'T0',
  tags: [kind === 'pmtiles' ? 'map' : 'places', `region:${region.iso2}`],
  region,
});

const CATALOG_PACKS: CatalogPackJson[] = [
  regional('map-cy', 'pmtiles', 55_924_719, CY, '1'),
  regional('places-cy', 'places', 520_192, CY, '2'),
  // A newer Greece map than the installed one (an update) and the installed places pack.
  regional('map-gr', 'pmtiles', 509_905_529, GR, '3'),
  regional('places-gr', 'places', 5_292_032, GR, 'd'),
  regional('map-de-bavaria', 'pmtiles', 1_300_000_000, DE_BAVARIA, '4'),
  regional('map-de-hesse', 'pmtiles', 802_000_000, DE_HESSE, '5'),
  regional('places-de', 'places', 43_900_000, DE, '6'),
  {
    id: 'wikipedia_en_medicine_mini',
    kind: 'zim',
    version: '2026-04',
    file: 'wikipedia_en_medicine_mini_2026-04.zim',
    title: { en: 'WikiMed (mini)' },
    lang: ['en'],
    sizeBytes: 162855323,
    sha256: SHA('f'),
    chunkSize: 67108864,
    chunkSha256: [SHA('f'), SHA('f'), SHA('f')],
    urls: ['https://download.kiwix.org/zim/x.zim'],
    license: 'CC-BY-SA-4.0',
    attribution: 'Wikipedia',
    minTier: 'T0',
    tags: [],
  },
];

const PLACES: Row[] = [{ id: 1, name: 'Πάτρα', name_en: 'Patras', name_local: 'Πάτρα', category: 'settlement', kind: 'city', importance: 10, lat: 38.2466, lon: 21.7346, score: -1 }];
const POIS: Row[] = [
  { id: 2, name: 'Γενικό Νοσοκομείο', name_en: 'General Hospital', name_local: null, category: 'hospital', kind: 'hospital', importance: 5, lat: 38.25, lon: 21.74 },
  { id: 3, name: 'Φαρμακείο', name_en: null, name_local: null, category: 'pharmacy', kind: 'pharmacy', importance: 1, lat: 38.245, lon: 21.735 },
];

export interface MockRecord {
  calls: { command: string; args: Record<string, unknown> }[];
  viewer: { archiveId: string; path: string; anchor: string | null }[];
  station: { manifest: string; packIds: string[] } | null;
  /** Last problem report saved (report_save). */
  report: string | null;
  emit: (event: string, payload: string) => void;
}

declare global {
  interface Window {
    __skepiMock?: MockRecord;
  }
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

function search(query: string, suggest: boolean): Row[] {
  const q = words(query);
  return ARTICLES.filter((a) => {
    const hay = words(`${a.title} ${suggest ? '' : a.sections.map((s) => s.text).join(' ')}`);
    return q.length > 0 && q.every((w) => hay.some((h) => h.startsWith(w)));
  }).map((a, rank) => ({ archiveId: ARCHIVE, path: a.path, title: a.title, snippet: null, score: null, rank }));
}

const SOURCE_RE = /<source id="(S\d+)"[^>]*>([\s\S]*?)<\/source>/;

function answerFor(prompt: string): string {
  // Copy a sentence of the first source verbatim (supported by construction).
  const m = prompt.match(SOURCE_RE);
  if (!m) return '{"covered":false,"sentences":[{"text":"No answer.","source":"S1"}]}';
  const sentence = (m[2] ?? '').split(/(?<=\.)\s/)[0]?.trim() ?? '';
  return JSON.stringify({ covered: true, sentences: [{ text: sentence, source: m[1] }] });
}

export function mockBackend(): Backend {
  const listeners = new Map<string, ((payload: string) => void)[]>();
  const record: MockRecord = {
    calls: [],
    viewer: [],
    station: null,
    report: null,
    emit: (event, payload) => {
      for (const l of listeners.get(event) ?? []) l(payload);
    },
  };
  window.__skepiMock = record;
  const packs = PACKS.map((p) => ({ ...p }));
  const settings = new Map<string, unknown>([['disclaimer.acceptedAt', 1]]);
  let stationRunning = false;

  const archives = (): OpenArchive[] => [
    { archiveId: ARCHIVE, path: packs[0]?.path ?? '', title: 'Smoke', language: 'eng', name: 'smoke', articleCount: ARTICLES.length, hasFulltextIndex: true, hasTitleIndex: true, mainPath: null, sizeBytes: 221833, packId: 'test-smoke-en', verified: true },
  ];

  const state = (): ContentState => ({
    root: 'C:\\SKEPI\\content',
    catalog: { catalog: { sequence: 3, keyId: 'cat-test-2026a', packs: CATALOG_PACKS }, bytesBase64: 'e30=', signature: 'c2ln', origin: 'embedded', sha256: SHA('0'), purpose: 'test', rejected: [], updateUrls: [] },
    // Fresh objects on every call, like IPC.
    packs: packs.map((p) => ({ ...p })),
  });

  const stationInfo = (packIds: string[], host: string, withApk: boolean) => ({
    host,
    port: 45123,
    token: '0123456789abcdef0123456789abcdef',
    certSha256: SHA('9'),
    apkUrl: withApk ? `http://${host}:45124/` : null,
    apkCertSha256: withApk ? '7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e' : null,
    packs: packIds,
  });

  const handlers: Record<string, (a: Record<string, unknown>) => unknown> = {
    zim_open_installed: () => archives(),
    zim_suggest: (a) => ({ hits: search(String(a.query), true).slice(0, Number(a.limit)), nativeMs: 1 }),
    zim_search: (a) => ({ hits: search(String(a.query), false).slice(0, Number(a.limit)), nativeMs: 2 }),
    zim_plain_text: (a) => {
      const art = ARTICLES.find((x) => x.path === a.path);
      if (!art) throw new Error('ERR_ZIM_ENTRY_NOT_FOUND');
      return { archiveId: ARCHIVE, path: art.path, title: art.title, sections: art.sections, cached: false };
    },
    zim_article: (a) => ({ archiveId: ARCHIVE, path: String(a.path), title: String(a.path), mimeType: 'text/html', html: '<p>x</p>' }),
    viewer_open: (a) => {
      record.viewer.push({ archiveId: String(a.archiveId), path: String(a.path), anchor: (a.anchor as string | null) ?? null });
      return null;
    },
    viewer_close: () => null,
    llm_load: (a) => {
      (a.onProgress as Stream<number>).onmessage(1);
      return { modelId: 'qwen2.5-1.5b-instruct-q4_0', contextSize: 8192, loadMs: 5, description: 'mock', gpu: true, devices: ['Mock GPU'], reasonNoGpu: '' };
    },
    llm_generate: (a) => {
      const req = a.request as { messages: { content: string }[]; maxTokens: number };
      if (req.maxTokens <= 1) return { text: '', promptTokens: 10, cachedPromptTokens: 0, generatedTokens: 0, timeToFirstTokenMs: 1, tokensPerSecond: null, stopReason: 'limit' };
      const text = answerFor(req.messages.map((m) => m.content).join('\n'));
      const sink = a.onToken as Stream<string>;
      for (let i = 0; i < text.length; i += 4) sink.onmessage(text.slice(i, i + 4));
      return { text, promptTokens: 200, cachedPromptTokens: 60, generatedTokens: 30, timeToFirstTokenMs: 40, tokensPerSecond: 90, stopReason: 'eos' };
    },
    llm_abort: () => null,
    llm_unload: () => null,
    device_info: () => ({
      snapshot: { totalRamMb: 65_300, freeRamMb: 40_000, freeDiskMb: 500_000, batteryPct: 100, charging: true, thermal: 'nominal' },
      cpu: { cores: 20, performanceCores: 6, performanceCoreIds: [0, 2, 4, 6, 8, 10] },
      gpu: { index: 0, name: 'Vulkan0', description: 'Mock GPU', backend: 'Vulkan', vramMb: 8188, integrated: false },
      loaded: null,
    }),
    content_state: () => state(),
    content_reconcile: (a) => {
      (a.onProgress as Stream<{ file: string; percent: number }>).onmessage({ file: 'eval-smoke-en.zim', percent: 100 });
      return { registered: ['test-smoke-en'], unverified: [], rejectedModels: [], rejectedMaps: [], missing: [], changed: [], partialsRemoved: 0 };
    },
    content_download: (a) => {
      const id = String(a.packId);
      const entry = CATALOG_PACKS.find((p) => p.id === id);
      if (!entry) throw new Error('ERR_UNKNOWN_PACK');
      const sink = a.onProgress as Stream<Record<string, unknown>>;
      for (const [phase, bytes] of [
        ['downloading', entry.sizeBytes / 2],
        ['verifying', entry.sizeBytes],
        ['done', entry.sizeBytes],
      ] as const) {
        sink.onmessage({ packId: id, phase, bytes, totalBytes: entry.sizeBytes, mirror: 0, rejectedMirrors: 0, error: null });
      }
      const folder = entry.kind === 'zim' ? 'zim' : entry.kind === 'gguf' ? 'models' : 'maps';
      const row: PackRow = { id, kind: entry.kind, version: entry.version, title: entry.title.en, path: `C:/content/${folder}/${entry.file}`, sizeBytes: entry.sizeBytes, sha256: entry.sha256, verified: true, catalogSeq: 3, license: entry.license, source: 'download', consentAt: null, installedAt: 2, lastOpenedAt: null };
      // An update replaces the installed version of the pack.
      const old = packs.findIndex((p) => p.id === id);
      if (old >= 0) packs.splice(old, 1);
      packs.push(row);
      return row;
    },
    content_cancel: () => null,
    content_check_update: () => 4,
    content_import: () => null,
    content_verify: (a) => ({ ok: true, sha256: packs.find((p) => p.id === a.packId)?.sha256 ?? '', expected: null }),
    content_remove: (a) => {
      const i = packs.findIndex((p) => p.id === a.packId);
      if (i >= 0) packs.splice(i, 1);
      return null;
    },
    content_consent: (a) => {
      const p = packs.find((x) => x.id === a.packId);
      if (p) p.consentAt = 3;
      return null;
    },
    content_choose_folder: () => null,
    settings_get: (a) => settings.get(String(a.key)) ?? null,
    settings_set: (a) => {
      settings.set(String(a.key), a.value);
      return null;
    },
    places_query: (a) => {
      const sql = String(a.sql);
      const params = Array.isArray(a.params) ? (a.params as unknown[]) : [];
      if (sql.includes('FROM meta')) return [{ key: 'attribution', value: '© OpenStreetMap contributors (ODbL 1.0)' }];
      if (sql.includes('places_fts')) return typeof params[0] === 'string' && params[0].toLowerCase().includes('patr') ? PLACES : [];
      return POIS;
    },
    station_addresses: () => [{ ip: '192.168.1.20', adapter: 'Wi-Fi', virtualAdapter: false }],
    station_choose_apk: () => ({ fileName: 'skepi.apk', sizeBytes: 50_000_000, signingSha256: '7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e' }),
    station_start: (a) => {
      const ids = (a.packIds as string[]).slice();
      record.station = { manifest: String(a.manifest), packIds: ids };
      stationRunning = true;
      return stationInfo(ids, String(a.host), a.withApk === true);
    },
    station_stop: () => {
      stationRunning = false;
      return null;
    },
    report_save: (a) => {
      record.report = String(a.text);
      return 'C:/Users/tester/Documents/skepi-problem-report.txt';
    },
    station_status: () =>
      record.station
        ? {
            info: stationInfo(record.station.packIds, '192.168.1.20', false),
            status: {
              running: stationRunning,
              port: 45123,
              requests: 3,
              bytesServed: 2_000_000,
              activeConnections: 0,
              lastActivityAtMs: Date.now(),
              stopReason: stationRunning ? null : 'stopped',
              peers: ['192.168.1.31'],
              log: [{ method: 'GET', path: '/manifest', status: 200, peer: '192.168.1.31', atMs: Date.now() }],
            },
          }
        : { info: null, status: null },
  };

  return {
    invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      record.calls.push({ command, args });
      const h = handlers[command];
      if (!h) return Promise.reject(new Error(`mock: unknown command ${command}`));
      try {
        return Promise.resolve(h(args) as T);
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    channel<T>(onmessage: (value: T) => void): Stream<T> {
      return { onmessage };
    },
    listen(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return Promise.resolve(() => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((l) => l !== handler),
        );
      });
    },
  };
}
