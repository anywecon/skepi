import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCatalog, type Catalog } from '@skepi/core';
import { getPack, upsertPack, type SqlDatabase } from '@skepi/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeFs, memoryDb } from './fakeNative';

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
