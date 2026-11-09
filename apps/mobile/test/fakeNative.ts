/**
 * In-memory stand-ins for the native modules the app's ContentStore calls (expo-content-store,
 * expo-hash) and an op-sqlite-like database over node:sqlite. A file has an inode and modification /
 * change times like a real one; its stamp is built from them as the native `fileStamp` does.
 */
import { createHash } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { migrate, type Row, type SqlDatabase, type SqlValue } from '@skepi/db';

export const ROOT = '/data/user/0/org.skepi.app/files/content';
/** App-specific external storage, where packs lived on Android 7–10 before this version. */
export const LEGACY_ROOT = '/storage/emulated/0/Android/data/org.skepi.app/files';

interface FakeFile {
  bytes: Uint8Array;
  ino: number;
  mtime: number;
  ctime: number;
}

export class FakeFs {
  readonly files = new Map<string, FakeFile>();
  /** Picked documents (Storage Access Framework URIs) and their bytes. */
  readonly documents = new Map<string, { name: string; bytes: Uint8Array }>();
  /** Absolute paths hashed, in order. */
  readonly hashed: string[] = [];
  /** Runs right after a hash finished, before the caller continues (another process writing). */
  afterHash: ((path: string) => void) | null = null;
  /** Android 7–10: packs an older version left in external storage, by content path. */
  readonly legacy = new Map<string, Uint8Array>();
  /** Free internal storage (moveLegacyFile needs the file size plus a reserve). */
  freeBytes = 1e12;
  /** Content paths for which moveLegacyFile throws (a native error). */
  readonly legacyThrows = new Set<string>();
  /** Downloads handed to the (fake) DownloadManager, by id - 1. */
  readonly downloads: { url: string; fileName: string; removed: boolean }[] = [];
  /** What queryDownload reports for a running download. */
  downloadState: (id: number) => { status: string; reason: number; bytes: number; totalBytes: number } = () => ({
    status: 'running',
    reason: 0,
    bytes: 0,
    totalBytes: -1,
  });
  private nextIno = 1;
  private clock = 1_000;

  reset(): void {
    this.files.clear();
    this.documents.clear();
    this.hashed.length = 0;
    this.afterHash = null;
    this.downloads.length = 0;
    this.legacy.clear();
    this.freeBytes = 1e12;
    this.legacyThrows.clear();
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  abs(rel: string): string {
    return `${ROOT}/${rel}`;
  }

  rel(path: string): string {
    if (!path.startsWith(`${ROOT}/`)) throw new Error(`outside the content root: ${path}`);
    return path.slice(ROOT.length + 1);
  }

  write(rel: string, bytes: Uint8Array): void {
    const now = this.tick();
    this.files.set(rel, { bytes, ino: this.nextIno++, mtime: now, ctime: now });
  }

  read(rel: string): Uint8Array {
    const f = this.files.get(rel);
    if (!f) throw new Error(`no file ${rel}`);
    return f.bytes;
  }

  /** Same file, same size, new bytes; optionally the old modification time set back. */
  overwriteInPlace(rel: string, bytes: Uint8Array, restoreMtime: boolean): void {
    const f = this.files.get(rel);
    if (!f) throw new Error(`no file ${rel}`);
    const now = this.tick();
    this.files.set(rel, { bytes, ino: f.ino, mtime: restoreMtime ? f.mtime : now, ctime: now });
  }

  /** A new file renamed over the old one, with the old modification time. */
  replaceByRename(rel: string, bytes: Uint8Array): void {
    const f = this.files.get(rel);
    if (!f) throw new Error(`no file ${rel}`);
    this.files.set(rel, { bytes, ino: this.nextIno++, mtime: f.mtime, ctime: this.tick() });
  }

  stamp(rel: string): string | null {
    const f = this.files.get(rel);
    return f ? `t1:${String(f.bytes.length)}:1:${String(f.ino)}:${String(f.mtime)}:${String(f.ctime)}` : null;
  }

  readonly contentStore = {
    getContentRoot: (): string => ROOT,
    fileInfo: (rel: string) => {
      const f = this.files.get(rel);
      return { exists: f !== undefined, sizeBytes: f?.bytes.length ?? 0, path: this.abs(rel), stamp: this.stamp(rel) };
    },
    listDir: (dir: string) =>
      [...this.files.entries()]
        .filter(([rel]) => rel.startsWith(`${dir}/`))
        .map(([rel, f]) => ({ name: rel.slice(dir.length + 1), path: this.abs(rel), sizeBytes: f.bytes.length }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    installFile: (from: string, to: string): Promise<string> => {
      const f = this.files.get(from);
      if (!f) return Promise.reject(new Error(`nothing at ${from}`));
      this.files.delete(from);
      // rename(2): same inode, new change time.
      this.files.set(to, { ...f, ctime: this.tick() });
      return Promise.resolve(this.abs(to));
    },
    deleteFile: (rel: string): Promise<boolean> => {
      this.files.delete(rel);
      return Promise.resolve(true);
    },
    importFromUri: (uri: string, fileName: string) => {
      const doc = this.documents.get(uri);
      if (!doc) return Promise.reject(new Error(`no document ${uri}`));
      const rel = `tmp/${fileName}.partial`;
      this.write(rel, doc.bytes);
      return Promise.resolve({ displayName: doc.name, sizeBytes: doc.bytes.length, relativePath: rel, path: this.abs(rel) });
    },
    adoptDownload: (fileName: string): Promise<string> => Promise.resolve(this.abs(`tmp/${fileName}.partial`)),
    getFreeBytes: (): number => 1e12,
    requiredFreeBytes: (sizeBytes: number): number => sizeBytes,
    startDownload: (url: string, fileName: string): Promise<number> => {
      this.downloads.push({ url, fileName, removed: false });
      return Promise.resolve(this.downloads.length);
    },
    queryDownload: (id: number) => (this.downloads[id - 1]?.removed ? null : this.downloadState(id)),
    removeDownload: (id: number): boolean => {
      const d = this.downloads[id - 1];
      if (d) d.removed = true;
      return d !== undefined;
    },
    legacyContent: (): string[] => [...this.legacy.keys()].sort(),
    // LegacyMigration.move: the external copy goes only after the internal copy matched.
    moveLegacyFile: (rel: string, expectedSha256: string) => {
      if (this.legacyThrows.has(rel)) return Promise.reject(new Error(`native failure for ${rel}`));
      const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
      const result = (moved: boolean, reason: string, sha256 = '') =>
        Promise.resolve({
          moved,
          reason: reason as '' | 'space' | 'copy' | 'conflict' | 'mismatch' | 'missing',
          path: moved ? this.abs(rel) : `${LEGACY_ROOT}/${rel}`,
          sha256,
          stamp: moved && sha256 === expectedSha256 ? this.stamp(rel) : null,
        });
      const external = this.legacy.get(rel);
      const internal = this.files.get(rel);
      if (!external) return internal ? result(true, '', sha(internal.bytes)) : result(false, 'missing');
      if (internal && internal.bytes.length !== external.length) {
        if (sha(internal.bytes) !== expectedSha256) return result(false, 'conflict');
        this.legacy.delete(rel);
        return result(true, '', expectedSha256);
      }
      if (!internal && this.freeBytes < external.length + 64 * 1024 * 1024) return result(false, 'space');
      if (!internal) this.write(rel, external);
      const copied = this.read(rel);
      if (sha(copied) !== expectedSha256) {
        this.files.delete(rel);
        const sourceSha = sha(external);
        return result(false, sourceSha === expectedSha256 ? 'copy' : 'mismatch', sourceSha);
      }
      this.legacy.delete(rel);
      return result(true, '', expectedSha256);
    },
    addListener: () => ({ remove: (): void => undefined }),
  };

  readonly hash = {
    hashFile: (path: string): Promise<{ sha256: string; sizeBytes: number; chunkSha256: string[] }> => {
      const bytes = this.read(this.rel(path));
      this.hashed.push(path);
      const digest = { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length, chunkSha256: [] };
      this.afterHash?.(path);
      return Promise.resolve(digest);
    },
  };
}

export const fakeFs = new FakeFs();

/** node:sqlite with the op-sqlite surface the app uses, migrated like app.db. */
export async function memoryDb(): Promise<SqlDatabase> {
  const raw = new DatabaseSync(':memory:');
  const execute = (sql: string, params: readonly SqlValue[] = []): Promise<{ rows: Row[] }> => {
    const stmt = raw.prepare(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)/i.test(sql)) return Promise.resolve({ rows: stmt.all(...(params as SQLInputValue[])) });
    stmt.run(...(params as SQLInputValue[]));
    return Promise.resolve({ rows: [] });
  };
  const db: SqlDatabase = {
    execute,
    transaction: async (fn) => {
      raw.prepare('BEGIN').run();
      try {
        await fn({ execute });
        raw.prepare('COMMIT').run();
      } catch (e) {
        raw.prepare('ROLLBACK').run();
        throw e;
      }
    },
  };
  await migrate(db);
  return db;
}
