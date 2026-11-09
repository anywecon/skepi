import type {
  CatalogEntry,
  ContentStore,
  DownloadProgress,
  InstalledPack,
  PackKind,
  VerifyResult,
} from '@skepi/contracts';
import { findPackBySha256, fromBase64, isAllowedDownloadUrl, toBase64, type Catalog } from '@skepi/core';
import {
  findPackByPath,
  getPack,
  getSetting,
  listPacks,
  removePack,
  setConsent,
  setSetting,
  upsertPack,
  type ActiveDownload,
  type PackRow,
  type SqlDatabase,
} from '@skepi/db';
import { ExpoContentStore, type NativeDownload, type NetworkState } from 'expo-content-store';
import { hashFile } from 'expo-hash';
import type { CatalogSource } from './catalog';

/**
 * ContentStore (Android): the only module that reaches the network (ESLint enforces it). Downloads
 * go through the system DownloadManager into tmp/<file>.partial; the file is hashed on a native
 * thread and only a file whose SHA-256 matches the signed catalog is moved into place and registered,
 * in that order. A mismatch deletes the file and tries the next mirror. Imports are copied into app
 * storage and hashed the same way; an unknown ZIM is registered as unverified (opens only after
 * explicit consent), an unknown GGUF is rejected.
 */
const POLL_MS = 500;
const DIRS: Readonly<Record<PackKind, 'zim' | 'models' | 'maps'>> = { zim: 'zim', gguf: 'models', pmtiles: 'maps', places: 'maps' };

export type ContentErrorCode =
  | 'insufficient_space'
  | 'no_mirror'
  | 'hash_mismatch'
  | 'download_failed'
  | 'unverified_model'
  | 'unsupported_file'
  | 'not_found';

export class ContentError extends Error {
  constructor(
    readonly code: ContentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The pack kind of a file in a content folder, from its extension (null: not a pack file). */
function fileKind(dir: 'zim' | 'models' | 'maps', name: string): PackKind | null {
  const n = name.toLowerCase();
  if (dir === 'zim') return n.endsWith('.zim') ? 'zim' : null;
  if (dir === 'models') return n.endsWith('.gguf') ? 'gguf' : null;
  if (n.endsWith('.pmtiles')) return 'pmtiles';
  return n.endsWith('.sqlite') ? 'places' : null;
}

/** Partial file of a pack received over P2P (kept across restarts for resuming). */
export function p2pPartialName(file: string): string {
  return `${file}.p2p.partial`;
}

function relativePath(kind: PackKind, file: string): string {
  return `${DIRS[kind]}/${file}`;
}

function toInstalled(p: PackRow): InstalledPack {
  return {
    id: p.id,
    kind: p.kind,
    version: p.version,
    title: p.title,
    path: p.path,
    sizeBytes: p.sizeBytes,
    sha256: p.sha256,
    verified: p.verified,
    source: p.source,
    consentAt: p.consentAt,
    license: p.license,
  };
}

/** Hashes an installed file and throws `hash_mismatch` unless it has exactly these bytes. */
async function requireDigest(path: string, sha256: string, sizeBytes: number): Promise<void> {
  const d = await hashFile(path);
  if (d.sha256 !== sha256 || d.sizeBytes !== sizeBytes) {
    throw new ContentError('hash_mismatch', `${path}: the installed file is not the file that was checked`);
  }
}

/** Reads the live flag (it can flip while a native call is awaited). */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export interface DownloadOptions {
  signal: AbortSignal;
  /** The user confirmed the size on a metered network (default: Wi-Fi only). */
  allowMetered: boolean;
}

export interface ReconcileReport {
  registered: string[];
  unverified: string[];
  /** Unknown GGUF files: never loaded (unverified models are not accepted on mobile). */
  rejectedModels: string[];
  /** Unknown map or places files: never opened (only packs of a valid signed catalog render). */
  rejectedMaps: string[];
  missing: string[];
  changed: string[];
  partialsRemoved: number;
}

export interface FreeSpace {
  freeBytes: number;
  requiredBytes: number;
  ok: boolean;
}

export class AndroidContentStore implements ContentStore {
  constructor(
    private readonly db: () => Promise<SqlDatabase>,
    private readonly catalog: () => Catalog | null,
  ) {}

  networkState(): NetworkState {
    return ExpoContentStore.getNetworkState();
  }

  freeSpace(sizeBytes: number): FreeSpace {
    const freeBytes = ExpoContentStore.getFreeBytes();
    const requiredBytes = ExpoContentStore.requiredFreeBytes(sizeBytes);
    return { freeBytes, requiredBytes, ok: freeBytes >= requiredBytes };
  }

  /** URLs this process handed to DownloadManager (zero-egress evidence). */
  networkLog(): ReturnType<typeof ExpoContentStore.getNetworkLog> {
    return ExpoContentStore.getNetworkLog();
  }

  async listInstalled(): Promise<InstalledPack[]> {
    return (await listPacks(await this.db())).map(toInstalled);
  }

  download(entry: CatalogEntry, signal: AbortSignal): AsyncIterable<DownloadProgress> {
    return this.downloadPack(entry, { signal, allowMetered: false });
  }

  /** Downloads, verifies and installs one catalog pack, trying its mirrors in order. */
  async *downloadPack(entry: CatalogEntry, options: DownloadOptions, resume?: ActiveDownload): AsyncGenerator<DownloadProgress> {
    const db = await this.db();
    const urls = entry.urls.filter(isAllowedDownloadUrl);
    if (urls.length === 0) throw new ContentError('no_mirror', `${entry.id}: no HTTPS mirror`);
    if (!resume) {
      const space = this.freeSpace(entry.sizeBytes);
      if (!space.ok) {
        throw new ContentError('insufficient_space', `${entry.id}: needs ${String(space.requiredBytes)} bytes free (file + 10% + 1 GB), has ${String(space.freeBytes)}`);
      }
    }
    const progress = (phase: DownloadProgress['phase'], mirror: number, rejected: number, bytes: number, error: string | null = null): DownloadProgress => ({
      packId: entry.id,
      phase,
      bytes,
      totalBytes: entry.sizeBytes,
      mirror,
      rejectedMirrors: rejected,
      error,
    });
    const partial = `tmp/${entry.file}.partial`;
    let rejected = resume?.rejectedMirrors ?? 0;
    let lastError: string | null = null;
    for (let mirror = resume?.mirror ?? 0; mirror < urls.length; mirror += 1) {
      const url = urls[mirror] ?? '';
      const downloadId =
        resume && mirror === resume.mirror ? resume.downloadId : await ExpoContentStore.startDownload(url, entry.file, entry.title.en, options.allowMetered);
      await this.trackActive(db, { packId: entry.id, downloadId, mirror, rejectedMirrors: rejected, allowMetered: options.allowMetered });
      // Set inside the polling loop; an object so control-flow analysis sees the assignment.
      const outcome: { done: NativeDownload | null; oversize: boolean } = { done: null, oversize: false };
      try {
        for (;;) {
          if (isAborted(options.signal)) {
            ExpoContentStore.removeDownload(downloadId);
            yield progress('cancelled', mirror, rejected, 0);
            return;
          }
          const q = ExpoContentStore.queryDownload(downloadId);
          // More bytes than the signed catalog says (announced or received): never a match, stop now
          // instead of filling the disk.
          if (q && (q.bytes > entry.sizeBytes || q.totalBytes > entry.sizeBytes)) {
            outcome.oversize = true;
            break;
          }
          if (!q || q.status === 'failed' || q.status === 'successful') {
            outcome.done = q;
            break;
          }
          yield progress(q.status === 'paused' ? 'waiting-for-network' : q.status === 'pending' ? 'queued' : 'downloading', mirror, rejected, q.bytes);
          await sleep(POLL_MS);
        }
      } finally {
        await this.untrackActive(db, entry.id, downloadId);
      }
      if (outcome.oversize) {
        ExpoContentStore.removeDownload(downloadId);
        await ExpoContentStore.deleteFile(partial);
        rejected += 1;
        lastError = `mirror ${String(mirror + 1)}: larger than the signed catalog size`;
        continue;
      }
      const done = outcome.done;
      if (done?.status !== 'successful') {
        lastError = `mirror ${String(mirror + 1)}: download failed (reason ${String(done?.reason ?? -1)})`;
        ExpoContentStore.removeDownload(downloadId);
        continue;
      }
      // Verify before anything can open the file, where nothing but the app can write it (Android
      // 7–10: DownloadManager wrote to external storage, the file is moved in first).
      try {
        await ExpoContentStore.adoptDownload(entry.file);
      } catch (e) {
        // Local storage, not the mirror: another mirror would fail the same way after a full download.
        ExpoContentStore.removeDownload(downloadId);
        await ExpoContentStore.deleteFile(partial);
        yield progress('failed', mirror, rejected, 0, e instanceof Error ? e.message : String(e));
        throw new ContentError('download_failed', `${entry.id}: the download could not be moved into app storage`);
      }
      const info = ExpoContentStore.fileInfo(partial);
      yield progress('verifying', mirror, rejected, info.sizeBytes);
      let sha256: string;
      try {
        sha256 = (await hashFile(info.path, { signal: options.signal })).sha256;
      } catch (e) {
        await ExpoContentStore.deleteFile(partial);
        ExpoContentStore.removeDownload(downloadId);
        if (isAborted(options.signal)) {
          yield progress('cancelled', mirror, rejected, 0);
          return;
        }
        throw e;
      }
      if (sha256 !== entry.sha256 || info.sizeBytes !== entry.sizeBytes) {
        // Wrong bytes from this mirror: delete them and try the next mirror.
        await ExpoContentStore.deleteFile(partial);
        ExpoContentStore.removeDownload(downloadId);
        rejected += 1;
        lastError = `mirror ${String(mirror + 1)}: SHA-256 mismatch`;
        continue;
      }
      yield progress('installing', mirror, rejected, info.sizeBytes);
      await this.install(db, entry, partial, sha256, 'download');
      // The DownloadManager entry pointed at the partial file, which is now moved: forget it.
      ExpoContentStore.removeDownload(downloadId);
      yield progress('done', mirror, rejected, info.sizeBytes);
      return;
    }
    yield progress('failed', urls.length - 1, rejected, 0, lastError);
    throw new ContentError(rejected > 0 ? 'hash_mismatch' : 'download_failed', `${entry.id}: ${lastError ?? 'no mirror succeeded'}`);
  }

  private async trackActive(db: SqlDatabase, d: ActiveDownload): Promise<void> {
    const active = (await getSetting(db, 'downloads.active')) ?? [];
    await setSetting(db, 'downloads.active', [...active.filter((a) => a.packId !== d.packId), d]);
  }

  private async untrackActive(db: SqlDatabase, packId: string, downloadId: number): Promise<void> {
    const active = (await getSetting(db, 'downloads.active')) ?? [];
    await setSetting(
      db,
      'downloads.active',
      active.filter((a) => !(a.packId === packId && a.downloadId === downloadId)),
    );
  }

  /** Downloads still known to DownloadManager after a restart (resumed by the Library screen). */
  async activeDownloads(): Promise<ActiveDownload[]> {
    const db = await this.db();
    const active = (await getSetting(db, 'downloads.active')) ?? [];
    const alive = active.filter((a) => ExpoContentStore.queryDownload(a.downloadId) !== null);
    if (alive.length !== active.length) await setSetting(db, 'downloads.active', alive);
    return alive;
  }

  /**
   * Atomic rename into place, then registration; a failed registration removes the file again.
   * `verifyInstalled` hashes the file again after the move (imports: the bytes that were looked up
   * must be the bytes that are registered).
   */
  private async install(
    db: SqlDatabase,
    entry: CatalogEntry,
    from: string,
    sha256: string,
    source: PackRow['source'],
    verifyInstalled = false,
  ): Promise<PackRow> {
    const target = relativePath(entry.kind, entry.file);
    const catalog = this.catalog();
    const row: PackRow = {
      id: entry.id,
      kind: entry.kind,
      version: entry.version,
      title: entry.title.en,
      path: '',
      sizeBytes: entry.sizeBytes,
      sha256,
      verified: true,
      catalogSeq: catalog?.sequence ?? null,
      license: entry.license,
      source,
      consentAt: null,
      installedAt: Date.now(),
      lastOpenedAt: null,
      fileStamp: null,
    };
    // An update (same pack id, new file) replaces the old version: its file goes only after the swap.
    const previous = await getPack(db, entry.id);
    const previousFile = previous ? (previous.path.split('/').pop() ?? '') : '';
    // Set inside the transaction callback; an object so control-flow analysis sees the assignment.
    const moved = { done: false };
    try {
      row.path = await ExpoContentStore.installFile(from, target);
      moved.done = true;
      row.fileStamp = ExpoContentStore.fileInfo(target).stamp;
      // Outside the transaction: a multi-GB hash must not hold the database.
      if (verifyInstalled) await requireDigest(row.path, entry.sha256, entry.sizeBytes);
      await db.transaction(async (tx) => {
        await upsertPack(tx, row);
      });
    } catch (e) {
      if (moved.done) await ExpoContentStore.deleteFile(target);
      throw e;
    }
    if (previous && previousFile.length > 0 && previous.path !== row.path) {
      await ExpoContentStore.deleteFile(relativePath(previous.kind, previousFile)).catch(() => undefined);
    }
    return row;
  }

  /**
   * Import from a file picked with the Storage Access Framework: copied into app storage (libzim
   * needs a real path), hashed, looked up in the catalog, moved into place and hashed again there
   * (what is registered is what was checked). Known → verified pack. Unknown ZIM →
   * unverified (opens only after consent, labelled, JavaScript off). Unknown GGUF → rejected.
   */
  async importFile(uri: string, onProgress?: (phase: 'copying' | 'verifying', bytes: number) => void): Promise<InstalledPack> {
    const db = await this.db();
    const stamp = `import-${String(Date.now())}`;
    const sub = onProgress
      ? ExpoContentStore.addListener('onImportProgress', (e) => {
          onProgress('copying', e.copiedBytes);
        })
      : null;
    let copied;
    try {
      copied = await ExpoContentStore.importFromUri(uri, stamp);
    } finally {
      sub?.remove();
    }
    try {
      const digest = await hashFile(copied.path, { onProgress: (hashed) => onProgress?.('verifying', hashed) });
      const catalog = this.catalog();
      const known = catalog ? findPackBySha256(catalog, digest.sha256) : null;
      if (known) {
        const row = await this.install(db, known, copied.relativePath, digest.sha256, 'import', true);
        return toInstalled(row);
      }
      const name = copied.displayName.toLowerCase();
      if (name.endsWith('.gguf')) throw new ContentError('unverified_model', 'This model file is not in the signed catalog. Unverified models are not accepted.');
      if (!name.endsWith('.zim')) throw new ContentError('unsupported_file', `Unsupported file: ${copied.displayName}`);
      const id = `import-${digest.sha256.slice(0, 12)}`;
      const file = `${id}.zim`;
      const row: PackRow = {
        id,
        kind: 'zim',
        version: 'unverified',
        title: copied.displayName,
        path: '',
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        verified: false,
        catalogSeq: null,
        license: null,
        source: 'import',
        consentAt: null,
        installedAt: Date.now(),
        lastOpenedAt: null,
        fileStamp: null,
      };
      const moved = { done: false };
      try {
        row.path = await ExpoContentStore.installFile(copied.relativePath, `zim/${file}`);
        moved.done = true;
        row.fileStamp = ExpoContentStore.fileInfo(`zim/${file}`).stamp;
        // The id and the registered hash name these bytes: hash what was installed.
        await requireDigest(row.path, digest.sha256, digest.sizeBytes);
        await db.transaction(async (tx) => {
          await upsertPack(tx, row);
        });
      } catch (e) {
        if (moved.done) await ExpoContentStore.deleteFile(`zim/${file}`);
        throw e;
      }
      return toInstalled(row);
    } finally {
      await ExpoContentStore.deleteFile(copied.relativePath);
    }
  }

  /** Full integrity check: hash the installed file and compare with the registered/catalog hash. */
  async verify(pack: InstalledPack, onProgress?: (hashed: number, total: number) => void): Promise<VerifyResult> {
    const digest = await hashFile(pack.path, onProgress ? { onProgress } : {});
    const catalog = this.catalog();
    const expected = catalog?.packs.find((p) => p.id === pack.id)?.sha256 ?? pack.sha256;
    return { ok: digest.sha256 === expected, sha256: digest.sha256, expected };
  }

  async remove(packId: string): Promise<void> {
    const db = await this.db();
    const row = await getPack(db, packId);
    if (!row) throw new ContentError('not_found', `${packId} is not installed`);
    const file = row.path.split('/').pop() ?? '';
    await removePack(db, packId);
    await ExpoContentStore.deleteFile(relativePath(row.kind, file));
  }

  /** Absolute path of a P2P partial file under tmp/ (where the transfer module writes chunks). */
  p2pPartial(file: string): { relative: string; path: string; exists: boolean; sizeBytes: number } {
    const relative = `tmp/${p2pPartialName(file)}`;
    const info = ExpoContentStore.fileInfo(relative);
    return { relative, path: info.path, exists: info.exists, sizeBytes: info.sizeBytes };
  }

  async deleteRelative(relative: string): Promise<void> {
    await ExpoContentStore.deleteFile(relative);
  }

  /**
   * Installs a pack received over P2P: the whole file is hashed again natively and must equal the
   * signed catalog's SHA-256 and size (every chunk was already checked on arrival); then the same
   * atomic rename and registration as a download. A mismatch deletes the file.
   */
  async installReceived(entry: CatalogEntry, partialRelative: string, onProgress?: (hashed: number, total: number) => void): Promise<InstalledPack> {
    const db = await this.db();
    const info = ExpoContentStore.fileInfo(partialRelative);
    const digest = await hashFile(info.path, onProgress ? { onProgress } : {});
    if (digest.sha256 !== entry.sha256 || digest.sizeBytes !== entry.sizeBytes) {
      await ExpoContentStore.deleteFile(partialRelative);
      throw new ContentError('hash_mismatch', `${entry.id}: received file does not match the signed catalog`);
    }
    return toInstalled(await this.install(db, entry, partialRelative, digest.sha256, 'p2p'));
  }

  /**
   * Registers a ZIM received over P2P that no valid catalog knows (the user chose it explicitly):
   * unverified, labelled, opened only after consent, like an imported file.
   */
  async installReceivedUnverified(title: string, partialRelative: string): Promise<InstalledPack> {
    const db = await this.db();
    const info = ExpoContentStore.fileInfo(partialRelative);
    const digest = await hashFile(info.path);
    const id = `p2p-${digest.sha256.slice(0, 12)}`;
    const row: PackRow = {
      id,
      kind: 'zim',
      version: 'unverified',
      title,
      path: '',
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
      verified: false,
      catalogSeq: null,
      license: null,
      source: 'p2p',
      consentAt: null,
      installedAt: Date.now(),
      lastOpenedAt: null,
      fileStamp: null,
    };
    await db.transaction(async (tx) => {
      row.path = await ExpoContentStore.installFile(partialRelative, `zim/${id}.zim`);
      row.fileStamp = ExpoContentStore.fileInfo(`zim/${id}.zim`).stamp;
      await upsertPack(tx, row);
    });
    return toInstalled(row);
  }

  async consent(packId: string): Promise<void> {
    await setConsent(await this.db(), packId, Date.now());
  }

  /**
   * Startup check (architecture: quick check of existence, size and file stamp; full hash when either
   * differs, so a same-size replacement cannot keep the verified state, and for files the database
   * does not know, e.g. provisioned by the dev scripts).
   */
  async reconcile(onProgress?: (file: string, hashed: number, total: number) => void): Promise<ReconcileReport> {
    const db = await this.db();
    const catalog = this.catalog();
    const report: ReconcileReport = { registered: [], unverified: [], rejectedModels: [], rejectedMaps: [], missing: [], changed: [], partialsRemoved: 0 };
    // Android 7–10: packs of older versions move from external into internal storage first.
    const legacy = await ExpoContentStore.migrateLegacyContent();
    const kept = new Set(legacy.kept);
    const known = await listPacks(db);
    for (const p of known) {
      const file = p.path.split('/').pop() ?? '';
      const info = ExpoContentStore.fileInfo(relativePath(p.kind, file));
      // A pack that could not move into internal storage yet stays registered where it is.
      if (!info.exists && kept.has(relativePath(p.kind, file))) continue;
      if (!info.exists) {
        await removePack(db, p.id);
        report.missing.push(p.id);
        continue;
      }
      // Taken before hashing: a write during the hash changes it again, so the next start hashes again.
      if (info.sizeBytes === p.sizeBytes && info.stamp !== null && info.stamp === p.fileStamp && info.path === p.path) continue;
      const digest = await hashFile(info.path, { onProgress: (h, t) => onProgress?.(file, h, t) });
      const entry = catalog ? findPackBySha256(catalog, digest.sha256) : null;
      const sameBytes = digest.sha256 === p.sha256 && digest.sizeBytes === p.sizeBytes;
      if (!sameBytes) report.changed.push(p.id);
      if (p.kind !== 'zim' && !entry) {
        // Unverified models, maps and places are never opened (app.db forbids them, too).
        await removePack(db, p.id);
        (p.kind === 'gguf' ? report.rejectedModels : report.rejectedMaps).push(file);
        continue;
      }
      await upsertPack(db, {
        ...p,
        path: info.path,
        sha256: digest.sha256,
        sizeBytes: digest.sizeBytes,
        verified: entry !== null,
        catalogSeq: entry ? (catalog?.sequence ?? null) : null,
        // Consent was given to the old bytes.
        consentAt: entry || !sameBytes ? null : p.consentAt,
        fileStamp: info.stamp,
      });
    }
    for (const dir of ['zim', 'models', 'maps'] as const) {
      for (const f of ExpoContentStore.listDir(dir)) {
        if (await findPackByPath(db, f.path)) continue;
        const kind = fileKind(dir, f.name);
        if (!kind) continue;
        const stamp = ExpoContentStore.fileInfo(`${dir}/${f.name}`).stamp;
        const digest = await hashFile(f.path, { onProgress: (h, t) => onProgress?.(f.name, h, t) });
        const entry = catalog ? findPackBySha256(catalog, digest.sha256) : null;
        if (entry && entry.kind === kind) {
          await upsertPack(db, {
            id: entry.id,
            kind,
            version: entry.version,
            title: entry.title.en,
            path: f.path,
            sizeBytes: digest.sizeBytes,
            sha256: digest.sha256,
            verified: true,
            catalogSeq: catalog?.sequence ?? null,
            license: entry.license,
            source: 'provisioned',
            consentAt: null,
            installedAt: Date.now(),
            lastOpenedAt: null,
            fileStamp: stamp,
          });
          report.registered.push(entry.id);
        } else if (kind === 'pmtiles' || kind === 'places') {
          report.rejectedMaps.push(f.name);
        } else if (kind === 'zim') {
          await upsertPack(db, {
            id: `local-${digest.sha256.slice(0, 12)}`,
            kind,
            version: 'unverified',
            title: f.name,
            path: f.path,
            sizeBytes: digest.sizeBytes,
            sha256: digest.sha256,
            verified: false,
            catalogSeq: null,
            license: null,
            source: 'provisioned',
            consentAt: null,
            installedAt: Date.now(),
            lastOpenedAt: null,
            fileStamp: stamp,
          });
          report.unverified.push(f.name);
        } else {
          report.rejectedModels.push(f.name);
        }
      }
    }
    // Stale partial files (architecture: tmp/ is cleaned on every start), except live downloads.
    const live = new Set((await this.activeDownloads()).map((a) => a.packId));
    const livePartials = new Set(catalog?.packs.filter((p) => live.has(p.id)).map((p) => `${p.file}.partial`) ?? []);
    // P2P partials of catalog packs stay: their verified chunks are the resume point of the next session.
    for (const p of catalog?.packs ?? []) livePartials.add(p2pPartialName(p.file));
    for (const f of ExpoContentStore.listDir('tmp')) {
      if (livePartials.has(f.name)) continue;
      await ExpoContentStore.deleteFile(`tmp/${f.name}`);
      report.partialsRemoved += 1;
    }
    return report;
  }
}

/** Signed catalog, pinned keys and update sources bundled in this build (assets/catalog). */
export function readEmbeddedCatalog(): ReturnType<typeof ExpoContentStore.readEmbeddedCatalog> {
  return ExpoContentStore.readEmbeddedCatalog();
}

/** Newest accepted catalog kept in internal storage (verified again on every start). */
export function readAcceptedCatalog(): ReturnType<typeof ExpoContentStore.readAcceptedCatalog> {
  return ExpoContentStore.readAcceptedCatalog();
}

export async function writeAcceptedCatalog(source: CatalogSource): Promise<void> {
  await ExpoContentStore.writeAcceptedCatalog(toBase64(source.bytes), source.signature);
}

async function downloadSmall(url: string, fileName: string, signal: AbortSignal): Promise<string> {
  const id = await ExpoContentStore.startDownload(url, fileName, 'SKEPI catalog', false);
  try {
    for (;;) {
      if (isAborted(signal)) throw new ContentError('download_failed', 'cancelled');
      const q = ExpoContentStore.queryDownload(id);
      if (!q || q.status === 'failed') throw new ContentError('download_failed', `${url}: download failed (reason ${String(q?.reason ?? -1)})`);
      if (q.status === 'successful') break;
      await sleep(POLL_MS);
    }
    await ExpoContentStore.adoptDownload(fileName);
    const data = await ExpoContentStore.readSmallFileBase64(`tmp/${fileName}.partial`);
    if (data === null) throw new ContentError('download_failed', `${url}: nothing downloaded`);
    return data;
  } finally {
    ExpoContentStore.removeDownload(id);
    await ExpoContentStore.deleteFile(`tmp/${fileName}.partial`);
  }
}

/**
 * Fetches `catalog.json` and `catalog.json.sig` from a catalog source (HTTPS, same rules as packs).
 * The result is only a candidate: the caller verifies signature and sequence before using it.
 */
export async function fetchCatalogUpdate(baseUrl: string, signal: AbortSignal): Promise<CatalogSource> {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const catalogUrl = `${base}catalog.json`;
  if (!isAllowedDownloadUrl(catalogUrl)) throw new ContentError('no_mirror', `${catalogUrl} is not an allowed URL`);
  const bytes = await downloadSmall(catalogUrl, 'catalog-update.json', signal);
  const sig = await downloadSmall(`${base}catalog.json.sig`, 'catalog-update.json.sig', signal);
  return { origin: 'update', bytes: fromBase64(bytes), signature: new TextDecoder().decode(fromBase64(sig)) };
}
