import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCatalog, type Catalog } from '@skepi/core';
import { getPack, upsertPack, type SqlDatabase } from '@skepi/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFs, LEGACY_ROOT, memoryDb } from './fakeNative';

vi.mock('expo-content-store', async () => ({ ExpoContentStore: (await import('./fakeNative')).fakeFs.contentStore }));
vi.mock('expo-hash', async () => ({ hashFile: (await import('./fakeNative')).fakeFs.hash.hashFile }));

const { AndroidContentStore } = await import('../src/lib/contentStore');

const repo = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const CATALOG: Catalog = parseCatalog(JSON.parse(readFileSync(repo('catalog/embedded/debug/catalog.json'), 'utf8')));
const SMOKE = new Uint8Array(readFileSync(repo('tools/rag-eval/fixtures/eval-smoke-en.zim')));
const SMOKE_ID = 'test-smoke-en';

function flipped(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice();
  out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 0xff;
  return out;
}

let db: SqlDatabase;
let store: InstanceType<typeof AndroidContentStore>;

beforeEach(async () => {
  fakeFs.reset();
  db = await memoryDb();
  store = new AndroidContentStore(() => Promise.resolve(db), () => CATALOG);
});

async function installSmoke(): Promise<string> {
  fakeFs.documents.set('content://picked/eval-smoke-en.zim', { name: 'eval-smoke-en.zim', bytes: SMOKE });
  const pack = await store.importFile('content://picked/eval-smoke-en.zim');
  expect(pack.id).toBe(SMOKE_ID);
  expect(pack.verified).toBe(true);
  return fakeFs.rel(pack.path);
}

describe('reconcile binds the verified state to the file, not to its size', () => {
  it('does not hash an unchanged pack again', async () => {
    await installSmoke();
    fakeFs.hashed.length = 0;
    const report = await store.reconcile();
    expect(report.changed).toEqual([]);
    expect(fakeFs.hashed).toEqual([]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(true);
  });

  it('a same-size overwrite in place loses the verified state', async () => {
    const rel = await installSmoke();
    fakeFs.overwriteInPlace(rel, flipped(SMOKE), false);
    const report = await store.reconcile();
    expect(report.changed).toEqual([SMOKE_ID]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(false);
  });

  it('a same-size overwrite with the old modification time restored loses the verified state', async () => {
    const rel = await installSmoke();
    fakeFs.overwriteInPlace(rel, flipped(SMOKE), true);
    const report = await store.reconcile();
    expect(report.changed).toEqual([SMOKE_ID]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(false);
  });

  it('a same-size replacement by rename loses the verified state', async () => {
    const rel = await installSmoke();
    fakeFs.replaceByRename(rel, flipped(SMOKE));
    const report = await store.reconcile();
    expect(report.changed).toEqual([SMOKE_ID]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(false);
  });

  it('a pack from before file stamps is hashed once, then trusted by its stamp', async () => {
    await installSmoke();
    const row = await getPack(db, SMOKE_ID);
    if (!row) throw new Error('not installed');
    await upsertPack(db, { ...row, fileStamp: null });
    fakeFs.hashed.length = 0;
    expect((await store.reconcile()).changed).toEqual([]);
    expect(fakeFs.hashed).toHaveLength(1);
    expect((await getPack(db, SMOKE_ID))?.fileStamp).not.toBeNull();
    fakeFs.hashed.length = 0;
    await store.reconcile();
    expect(fakeFs.hashed).toEqual([]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(true);
  });
});

describe('an upgrade keeps packs an earlier signed catalog verified', () => {
  // v0.1.x shipped catalog 3 with map-gr-20261005; catalog 4 lists map-gr-20261024 instead.
  // The newer catalog lists the same pack id in another version (other bytes).
  const NEWER: Catalog = {
    ...CATALOG,
    sequence: CATALOG.sequence + 1,
    packs: CATALOG.packs.map((p) => (p.id === SMOKE_ID ? { ...p, sha256: 'a'.repeat(64), file: 'eval-smoke-en-v2.zim' } : p)),
  };
  const MAP = new Uint8Array(4096).fill(7);
  const MAP_SHA = createHash('sha256').update(MAP).digest('hex');

  async function fromBeforeStamps(): Promise<void> {
    await installSmoke();
    const row = await getPack(db, SMOKE_ID);
    if (!row) throw new Error('not installed');
    await upsertPack(db, { ...row, fileStamp: null });
    fakeFs.write('maps/map-xx-20261005.pmtiles', MAP);
    await upsertPack(db, {
      ...row,
      id: 'map-xx',
      kind: 'pmtiles',
      title: 'Map: XX',
      path: fakeFs.abs('maps/map-xx-20261005.pmtiles'),
      sizeBytes: MAP.length,
      sha256: MAP_SHA,
      verified: true,
      catalogSeq: CATALOG.sequence,
      consentAt: null,
      fileStamp: null,
    });
    store = new AndroidContentStore(() => Promise.resolve(db), () => NEWER);
  }

  it('unchanged map and ZIM packs stay verified, with the catalog that verified them', async () => {
    await fromBeforeStamps();
    const report = await store.reconcile();
    expect(report.rejectedMaps).toEqual([]);
    expect(report.changed).toEqual([]);
    for (const id of [SMOKE_ID, 'map-xx']) {
      const p = await getPack(db, id);
      expect(p?.verified).toBe(true);
      expect(p?.catalogSeq).toBe(CATALOG.sequence);
      expect(p?.fileStamp).not.toBeNull();
      if (p) expect((await store.verify(p)).ok).toBe(true);
    }
  });

  it('changed bytes of such a pack are not trusted: the map is dropped, the ZIM is unverified', async () => {
    await fromBeforeStamps();
    fakeFs.overwriteInPlace('maps/map-xx-20261005.pmtiles', flipped(MAP), false);
    fakeFs.overwriteInPlace(fakeFs.rel((await getPack(db, SMOKE_ID))?.path ?? ''), flipped(SMOKE), false);
    const report = await store.reconcile();
    expect([...new Set(report.rejectedMaps)]).toEqual(['map-xx-20261005.pmtiles']);
    expect(await getPack(db, 'map-xx')).toBeNull();
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(false);
  });
});

describe('import verifies the bytes that end up installed', () => {
  it('a file changed between the hash and the move is not registered', async () => {
    fakeFs.documents.set('content://picked/eval-smoke-en.zim', { name: 'eval-smoke-en.zim', bytes: SMOKE });
    // Another writer changes the copy right after it was hashed in tmp/, before it moves into place.
    fakeFs.afterHash = (path) => {
      const rel = fakeFs.rel(path);
      if (rel.startsWith('tmp/')) {
        fakeFs.overwriteInPlace(rel, flipped(SMOKE), true);
        fakeFs.afterHash = null;
      }
    };
    await expect(store.importFile('content://picked/eval-smoke-en.zim')).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(await getPack(db, SMOKE_ID)).toBeNull();
    expect([...fakeFs.files.keys()].filter((k) => k.startsWith('zim/'))).toEqual([]);
  });

  it('an unchanged import is registered with the hash of the installed file', async () => {
    const rel = await installSmoke();
    expect(fakeFs.hashed.at(-1)).toBe(fakeFs.abs(rel));
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(true);
  });
});

describe('downloads stop at the catalog size', () => {
  async function run(state: { bytes: number; totalBytes: number }): Promise<unknown> {
    const entry = CATALOG.packs.find((p) => p.id === SMOKE_ID);
    if (!entry) throw new Error('no catalog entry');
    // One mirror only, so the outcome of that mirror is the outcome of the download.
    const one = { ...entry, urls: entry.urls.slice(0, 1) };
    fakeFs.downloadState = () => ({ status: 'running', reason: 0, ...state });
    const it = store.downloadPack(one, { signal: new AbortController().signal, allowMetered: false });
    const phases: string[] = [];
    try {
      for await (const p of it) phases.push(p.phase);
      return null;
    } catch (e) {
      return e;
    }
  }

  it('a mirror that announces more bytes than the catalog size is cancelled at once', async () => {
    const entry = CATALOG.packs.find((p) => p.id === SMOKE_ID);
    const e = await run({ bytes: 1024, totalBytes: (entry?.sizeBytes ?? 0) + 1 });
    expect(e).toMatchObject({ code: 'hash_mismatch' });
    expect(fakeFs.downloads.map((d) => d.removed)).toEqual([true]);
  });

  it('a mirror that sends more bytes than the catalog size is cancelled at once', async () => {
    const entry = CATALOG.packs.find((p) => p.id === SMOKE_ID);
    const e = await run({ bytes: (entry?.sizeBytes ?? 0) + 1, totalBytes: -1 });
    expect(e).toMatchObject({ code: 'hash_mismatch' });
    expect(fakeFs.downloads.map((d) => d.removed)).toEqual([true]);
  });
});

describe('Android 7–10 upgrade: packs move from external into internal storage', () => {
  /** A pack installed by an older version: its file and row point into external storage. */
  async function legacySmoke(): Promise<string> {
    const rel = await installSmoke();
    const row = await getPack(db, SMOKE_ID);
    if (!row) throw new Error('no row');
    fakeFs.legacy.set(rel, fakeFs.read(rel));
    fakeFs.files.delete(rel);
    await upsertPack(db, { ...row, path: `${LEGACY_ROOT}/${rel}`, fileStamp: null });
    return rel;
  }

  it('moves the pack, checked against its catalog digest, and keeps it verified', async () => {
    const rel = await legacySmoke();
    const report = await store.reconcile();
    expect(report.legacyKept).toEqual([]);
    expect(report.changed).toEqual([]);
    const row = await getPack(db, SMOKE_ID);
    expect(row?.verified).toBe(true);
    expect(row?.path).toBe(fakeFs.abs(rel));
    expect(row?.sha256).toBe(CATALOG.packs.find((p) => p.id === SMOKE_ID)?.sha256);
    expect(fakeFs.legacy.size).toBe(0);
    // The stamp was taken at the move: the next start trusts it without hashing.
    fakeFs.hashed.length = 0;
    await store.reconcile();
    expect(fakeFs.hashed).toEqual([]);
  });

  it('without enough internal space keeps the external copy, deletes nothing and says why', async () => {
    const rel = await legacySmoke();
    fakeFs.freeBytes = 1024;
    const report = await store.reconcile();
    expect(report.legacyKept).toEqual([{ file: 'eval-smoke-en.zim', reason: 'space' }]);
    expect(report.missing).toEqual([]);
    expect(fakeFs.legacy.has(rel)).toBe(true);
    expect(fakeFs.files.has(rel)).toBe(false);
    expect((await getPack(db, SMOKE_ID))?.path).toBe(`${LEGACY_ROOT}/${rel}`);
    // Space freed: the next start finishes the move.
    fakeFs.freeBytes = 1e12;
    expect((await store.reconcile()).legacyKept).toEqual([]);
    expect((await getPack(db, SMOKE_ID))?.path).toBe(fakeFs.abs(rel));
  });

  it('an external copy that no longer matches the catalog is kept on disk but no longer verified', async () => {
    const rel = await legacySmoke();
    fakeFs.legacy.set(rel, flipped(SMOKE));
    const report = await store.reconcile();
    expect(report.legacyKept).toEqual([{ file: 'eval-smoke-en.zim', reason: 'mismatch' }]);
    expect(report.changed).toEqual([SMOKE_ID]);
    expect(fakeFs.legacy.has(rel)).toBe(true);
    const row = await getPack(db, SMOKE_ID);
    expect(row?.verified).toBe(false);
    expect(row?.consentAt).toBeNull();
  });

  it('an internal file left without its external copy is trusted only after it is hashed', async () => {
    const rel = await legacySmoke();
    // Killed after the copy was renamed into place; then the external copy vanished and the internal
    // file holds other bytes.
    fakeFs.legacy.delete(rel);
    fakeFs.write(rel, flipped(SMOKE));
    const report = await store.reconcile();
    expect(report.changed).toEqual([SMOKE_ID]);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(false);
  });

  it('a kill between the move and the row update ends with the row on the internal copy, verified', async () => {
    const rel = await legacySmoke();
    // The native move finished (internal copy matched, external deleted); the row still points outside.
    fakeFs.write(rel, fakeFs.legacy.get(rel) ?? new Uint8Array());
    fakeFs.legacy.delete(rel);
    const report = await store.reconcile();
    expect(report.changed).toEqual([]);
    const row = await getPack(db, SMOKE_ID);
    expect(row?.verified).toBe(true);
    expect(row?.path).toBe(fakeFs.abs(rel));
  });

  it('a native error for one pack keeps it where it is and does not stop the startup check', async () => {
    const rel = await legacySmoke();
    fakeFs.legacyThrows.add(rel);
    const report = await store.reconcile();
    expect(report.legacyKept).toEqual([{ file: 'eval-smoke-en.zim', reason: 'failed' }]);
    expect(report.missing).toEqual([]);
    expect(fakeFs.legacy.has(rel)).toBe(true);
    expect((await getPack(db, SMOKE_ID))?.verified).toBe(true);
  });

  it('another file at the internal path is a conflict: both stay, the notice says so', async () => {
    const rel = await legacySmoke();
    fakeFs.write(rel, new Uint8Array(10));
    const report = await store.reconcile();
    expect(report.legacyKept).toEqual([{ file: 'eval-smoke-en.zim', reason: 'failed' }]);
    expect(fakeFs.legacy.has(rel)).toBe(true);
    expect(fakeFs.read(rel).length).toBe(10);
    const row = await getPack(db, SMOKE_ID);
    expect(row?.path).toBe(`${LEGACY_ROOT}/${rel}`);
    expect(row?.verified).toBe(true);
  });

  it('a pack gone from both places is missing as before', async () => {
    const rel = await legacySmoke();
    fakeFs.legacy.delete(rel);
    expect((await store.reconcile()).missing).toEqual([SMOKE_ID]);
  });
});
