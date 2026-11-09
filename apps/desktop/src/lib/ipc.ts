/**
 * The only module that talks to the native side (ESLint enforces it). Every call is one of the
 * narrow commands of apps/desktop/src-tauri/src/commands.rs; packs are named by id, never by path.
 * In Playwright E2E (`vite --mode e2e`) the same functions run against an in-memory mock backend.
 */
import type { ArticleSection } from '@skepi/contracts';
import type { PackRegion } from '@skepi/core';

export type PackKind = 'zim' | 'gguf' | 'pmtiles' | 'places';

export interface PackRow {
  id: string;
  kind: PackKind;
  version: string;
  title: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
  catalogSeq: number | null;
  license: string | null;
  source: 'download' | 'import' | 'provisioned' | 'p2p';
  consentAt: number | null;
  installedAt: number;
  lastOpenedAt: number | null;
}

export interface CatalogPackJson {
  id: string;
  kind: PackKind;
  version: string;
  file: string;
  title: { en: string; el?: string };
  lang: string[];
  sizeBytes: number;
  sha256: string;
  chunkSize: number;
  chunkSha256: string[];
  urls: string[];
  license: string;
  attribution: string;
  minTier: string;
  tags: string[];
  /** Schema 2 catalogs: the country of a map or places pack. */
  region?: PackRegion;
}

export interface CatalogSummary {
  catalog: { sequence: number; keyId: string; packs: CatalogPackJson[] } | null;
  bytesBase64: string | null;
  signature: string | null;
  origin: string | null;
  sha256: string | null;
  purpose: string | null;
  rejected: { origin: string; reason: string; detail: string }[];
  updateUrls: string[];
}

export interface ContentState {
  root: string;
  catalog: CatalogSummary;
  packs: PackRow[];
}

export interface OpenArchive {
  archiveId: string;
  path: string;
  title: string;
  language: string;
  name: string;
  articleCount: number;
  hasFulltextIndex: boolean;
  hasTitleIndex: boolean;
  mainPath: string | null;
  sizeBytes: number;
  packId: string;
  verified: boolean;
}

export interface Hit {
  archiveId: string;
  path: string;
  title: string;
  snippet: string | null;
  score: number | null;
  rank: number;
}

export interface Hits {
  hits: Hit[];
  nativeMs: number;
}

export interface ArticleHtml {
  archiveId: string;
  path: string;
  title: string;
  mimeType: string;
  html: string;
}

export interface ArticleTextJson {
  archiveId: string;
  path: string;
  title: string;
  sections: ArticleSection[];
  cached: boolean;
}

export interface NativeLoadOptions {
  contextSize: number;
  threads: number;
  useMmap: boolean;
  useMlock: boolean;
  gpuLayers: number;
}

export interface NativeLoaded {
  modelId: string;
  contextSize: number;
  loadMs: number;
  description: string;
  gpu: boolean;
  devices: string[];
  reasonNoGpu: string;
}

export interface NativeGenerateRequest {
  messages: { role: string; content: string }[];
  maxTokens: number;
  temperature: number;
  stop: string[];
  jsonSchema: Readonly<Record<string, unknown>> | null;
}

export interface NativeGenerateResult {
  text: string;
  promptTokens: number;
  cachedPromptTokens: number;
  generatedTokens: number;
  timeToFirstTokenMs: number | null;
  tokensPerSecond: number | null;
  stopReason: 'eos' | 'limit' | 'stop' | 'abort';
}

export interface DeviceInfo {
  snapshot: { totalRamMb: number; freeRamMb: number; freeDiskMb: number; batteryPct: number; charging: boolean; thermal: 'nominal' | 'fair' | 'serious' | 'critical' };
  cpu: { cores: number; performanceCores: number; performanceCoreIds: number[] };
  gpu: { index: number; name: string; description: string; backend: string; vramMb: number; integrated: boolean } | null;
  loaded: NativeLoaded | null;
}

export interface HashProgress {
  file: string;
  percent: number;
}

export interface ReconcileReport {
  registered: string[];
  unverified: string[];
  rejectedModels: string[];
  rejectedMaps: string[];
  missing: string[];
  changed: string[];
  partialsRemoved: number;
}

export interface DownloadProgressJson {
  packId: string;
  phase: 'queued' | 'waiting-for-network' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled';
  bytes: number;
  totalBytes: number;
  mirror: number;
  rejectedMirrors: number;
  error: string | null;
}

export interface VerifyResultJson {
  ok: boolean;
  sha256: string;
  expected: string | null;
}

export type Row = Record<string, unknown>;

export interface LocalAddress {
  ip: string;
  adapter: string;
  virtualAdapter: boolean;
}

export interface ApkChoice {
  fileName: string;
  sizeBytes: number;
  /** Read from the APK's signing block, not verified: shown to compare with the published value. */
  signingSha256: string;
}

export interface StationInfo {
  host: string;
  port: number;
  token: string;
  certSha256: string;
  apkUrl: string | null;
  apkCertSha256: string | null;
  packs: string[];
}

export interface StationStatus {
  running: boolean;
  port: number;
  requests: number;
  bytesServed: number;
  activeConnections: number;
  lastActivityAtMs: number;
  stopReason: string | null;
  peers: string[];
  log: { method: string; path: string; status: number; peer: string; atMs: number }[];
}

/** One streaming callback channel (Tauri `Channel`, or the mock's plain function). */
export interface Stream<T> {
  onmessage: (value: T) => void;
}

export interface Backend {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  channel<T>(onmessage: (value: T) => void): Stream<T>;
  listen(event: string, handler: (payload: string) => void): Promise<() => void>;
}

let backend: Promise<Backend> | null = null;

async function tauriBackend(): Promise<Backend> {
  const core = await import('@tauri-apps/api/core');
  const events = await import('@tauri-apps/api/event');
  return {
    invoke: (command, args) => core.invoke(command, args),
    channel: <T,>(onmessage: (value: T) => void) => {
      const c = new core.Channel<T>();
      c.onmessage = onmessage;
      return c;
    },
    listen: async (event, handler) => events.listen<string>(event, (e) => {
      handler(e.payload);
    }),
  };
}

function load(): Promise<Backend> {
  backend ??= import.meta.env.MODE === 'e2e' ? import('./mock').then((m) => m.mockBackend()) : tauriBackend();
  return backend;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return (await load()).invoke<T>(command, args);
}

async function channel<T>(onmessage: (value: T) => void): Promise<Stream<T>> {
  return (await load()).channel(onmessage);
}

export const ipc = {
  zimOpenInstalled: () => call<OpenArchive[]>('zim_open_installed'),
  zimSuggest: (query: string, limit: number, archiveIds: readonly string[] | null) => call<Hits>('zim_suggest', { query, limit, archiveIds }),
  zimSearch: (query: string, limit: number, archiveIds: readonly string[] | null) => call<Hits>('zim_search', { query, limit, archiveIds, withSnippets: false }),
  zimArticle: (archiveId: string, path: string) => call<ArticleHtml>('zim_article', { archiveId, path }),
  zimPlainText: (archiveId: string, path: string) => call<ArticleTextJson>('zim_plain_text', { archiveId, path }),
  viewerOpen: (archiveId: string, path: string, title: string, dark: boolean, anchor: string | null) =>
    call<null>('viewer_open', { archiveId, path, title, dark, anchor }),
  viewerClose: () => call<null>('viewer_close'),
  llmLoad: async (modelPackId: string, options: NativeLoadOptions, onProgress: (f: number) => void) =>
    call<NativeLoaded>('llm_load', { modelPackId, options, onProgress: await channel(onProgress) }),
  llmGenerate: async (request: NativeGenerateRequest, onToken: (t: string) => void) =>
    call<NativeGenerateResult>('llm_generate', { request, onToken: await channel(onToken) }),
  llmAbort: () => call<null>('llm_abort'),
  llmUnload: () => call<null>('llm_unload'),
  deviceInfo: () => call<DeviceInfo>('device_info'),
  contentState: () => call<ContentState>('content_state'),
  contentReconcile: async (onProgress: (p: HashProgress) => void) => call<ReconcileReport>('content_reconcile', { onProgress: await channel(onProgress) }),
  contentDownload: async (packId: string, onProgress: (p: DownloadProgressJson) => void) =>
    call<PackRow>('content_download', { packId, onProgress: await channel(onProgress) }),
  contentCancel: (packId: string) => call<null>('content_cancel', { packId }),
  contentCheckUpdate: () => call<number | null>('content_check_update'),
  contentImport: async (onProgress: (p: HashProgress) => void) => call<PackRow | null>('content_import', { onProgress: await channel(onProgress) }),
  contentVerify: (packId: string) => call<VerifyResultJson>('content_verify', { packId }),
  contentRemove: (packId: string) => call<null>('content_remove', { packId }),
  contentConsent: (packId: string) => call<null>('content_consent', { packId }),
  contentChooseFolder: () => call<ContentState | null>('content_choose_folder'),
  settingsGet: (key: string) => call<unknown>('settings_get', { key }),
  settingsSet: (key: string, value: unknown) => call<null>('settings_set', { key, value }),
  placesQuery: (packId: string, sql: string, params: readonly unknown[]) => call<Row[]>('places_query', { packId, sql, params }),
  stationAddresses: () => call<LocalAddress[]>('station_addresses'),
  stationChooseApk: () => call<ApkChoice | null>('station_choose_apk'),
  stationStart: (host: string, packIds: readonly string[], manifest: string, withApk: boolean) =>
    call<StationInfo>('station_start', { host, packIds, manifest, withApk }),
  stationStop: () => call<null>('station_stop'),
  stationStatus: () => call<{ info: StationInfo | null; status: StationStatus | null }>('station_status'),
  /** Problem report "Save for later": native save dialog, .txt only; null when cancelled. */
  reportSave: (text: string) => call<string | null>('report_save', { text }),
  onViewerExternal: async (handler: (url: string) => void) => (await load()).listen('viewer-external', handler),
};
