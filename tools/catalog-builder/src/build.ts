import {
  CATALOG_CHUNK_SIZE,
  CATALOG_SCHEMA,
  CATALOG_SCHEMA_REGIONS,
  KEY_LIST_SCHEMA,
  parseCatalog,
  parseKeyList,
  signBytes,
  utf8,
  verifyCatalog,
  verifyKeyList,
  type Catalog,
  type CatalogPack,
  type KeyList,
  type TrustedKey,
} from '@skepi/core';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { downloadTo, fetchUpstreamMd5, fetchUpstreamSha256 } from './download';
import { digestFile } from './hash';
import { REPO_ROOT } from './keys';
import { extractMap } from './mapExtract';
import { extractOsm, mergeCandidates, readCandidates, writePlacesPack, type OsmCandidate } from './places';
import type { Manifest, ManifestPack } from './manifest';

export interface SigningKey {
  keyId: string;
  secretKey: Uint8Array;
}

export interface Signed {
  bytes: Uint8Array;
  /** Base64 Ed25519 signature over `bytes` (the content of `<file>.sig`). */
  signature: string;
}

/** What measuring the packs needs (no key). */
export interface MeasureOptions {
  manifest: Manifest;
  /** Where downloads are cached (and where already downloaded files are found). */
  cacheDir: string;
  /** Root for `local` sources (default: the repository). */
  localRoot?: string;
  log?: (line: string) => void;
}

export interface BuildOptions extends MeasureOptions {
  key: SigningKey;
  /** Sequence of the catalog this one replaces; the new one must be higher. */
  previousSequence: number | null;
  /** Explicit sequence; default previous + 1. */
  sequence?: number;
  issuedAt?: string;
  /** SHA-256 of pack files the catalog revokes (architecture "Pack trust across catalogs"). */
  revoked?: readonly string[];
}

/** `prepare`: the same as a build, but the key is only named; nothing is signed. */
export type PrepareOptions = Omit<BuildOptions, 'key'> & { keyId: string };

/** Sequence of an existing catalog file, or null when there is none. */
export function sequenceOf(path: string): number | null {
  if (!existsSync(path)) return null;
  return parseCatalog(JSON.parse(readFileSync(path, 'utf8')) as unknown).sequence;
}

export function nextSequence(previous: number | null, requested: number | undefined): number {
  const sequence = requested ?? (previous ?? 0) + 1;
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error(`invalid sequence ${String(sequence)}`);
  if (previous !== null && sequence <= previous) {
    throw new Error(`sequence must always increase: ${String(sequence)} <= previous ${String(previous)}`);
  }
  return sequence;
}

async function packFile(pack: ManifestPack, opts: MeasureOptions): Promise<{ path: string; upstream: string | null }> {
  const log = opts.log ?? (() => undefined);
  const source = pack.source;
  if (source.kind === 'local') {
    const root = opts.localRoot ?? REPO_ROOT;
    return { path: isAbsolute(source.path) ? source.path : resolve(root, source.path), upstream: null };
  }
  await mkdir(opts.cacheDir, { recursive: true });
  if (source.kind === 'pmtiles-extract') {
    const path = await extractMap({ ...source, out: join(opts.cacheDir, pack.file), cacheDir: opts.cacheDir, log });
    return { path, upstream: null };
  }
  if (source.kind === 'osm-places') {
    const out = join(opts.cacheDir, pack.file);
    if (!existsSync(out)) {
      const urls = [source.url, ...(source.more ?? [])];
      const lists: OsmCandidate[][] = [];
      for (const [i, url] of urls.entries()) {
        const pbf = await downloadTo(url, join(opts.cacheDir, url.split('/').pop() ?? `${pack.id}-${String(i)}.osm.pbf`), log);
        const md5 = await md5File(pbf);
        const upstream = await fetchUpstreamMd5(i === 0 ? source.upstreamMd5Url : `${url}.md5`);
        if (md5 !== upstream) throw new Error(`${pack.id}: OSM extract MD5 ${md5} does not match the publisher's ${upstream} (${pbf})`);
        // The candidate list is kept beside the pack: rebuilding the pack does not re-read the PBF.
        const ndjson = i === 0 ? `${out}.ndjson` : `${out}.${String(i)}.ndjson`;
        if (!existsSync(ndjson)) await extractOsm(pbf, ndjson, source.locale, { ...(source.boundary ? { boundary: source.boundary } : {}), log });
        lists.push(await readCandidates(ndjson));
      }
      const report = await writePlacesPack(mergeCandidates(lists), out, { region: source.region, locale: source.locale, source: urls.join(' ') });
      log(`${pack.id}: ${String(report.rows)} places ${JSON.stringify(report.byCategory)}`);
    }
    return { path: out, upstream: null };
  }
  const path = await downloadTo(source.url, join(opts.cacheDir, pack.file), log);
  const upstream = 'upstreamSha256Url' in source ? await fetchUpstreamSha256(source.upstreamSha256Url) : source.upstreamSha256;
  return { path, upstream };
}

export async function md5File(path: string): Promise<string> {
  const h = createHash('md5');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) h.update(chunk);
  return h.digest('hex');
}

/** Builds or downloads one pack, measures it and checks it against the publisher's checksum. */
export async function measurePack(p: ManifestPack, opts: MeasureOptions): Promise<{ pack: CatalogPack; path: string }> {
  const log = opts.log ?? (() => undefined);
  const { path, upstream } = await packFile(p, opts);
  const digest = await digestFile(path, p.chunkSize ?? CATALOG_CHUNK_SIZE);
  if (upstream !== null && upstream !== digest.sha256) {
    throw new Error(`${p.id}: SHA-256 ${digest.sha256} does not match the publisher's ${upstream} (${path})`);
  }
  log(`${p.id}: ${String(digest.sizeBytes)} bytes, sha256 ${digest.sha256}${upstream ? ' (matches upstream)' : ' (local file)'}`);
  return {
    path,
    pack: {
      id: p.id,
      kind: p.kind,
      version: p.version,
      file: p.file,
      title: p.title,
      lang: p.lang,
      sizeBytes: digest.sizeBytes,
      sha256: digest.sha256,
      chunkSize: digest.chunkSize,
      chunkSha256: digest.chunkSha256,
      urls: p.urls,
      license: p.license,
      attribution: p.attribution,
      minTier: p.minTier,
      tags: p.tags,
      ...(p.region ? { region: p.region } : {}),
    },
  };
}

/** Measures every pack (SHA-256, 64 MB chunk hashes) and checks it against the publisher's checksum. */
export async function measurePacks(opts: MeasureOptions): Promise<CatalogPack[]> {
  const packs: CatalogPack[] = [];
  for (const p of opts.manifest.packs) packs.push((await measurePack(p, opts)).pack);
  return packs;
}

/** Schema 2 as soon as one pack has a region (apps before global maps reject it as a whole). */
export function catalogSchema(packs: readonly CatalogPack[]): Catalog['schema'] {
  return packs.some((p) => p.region !== undefined) ? CATALOG_SCHEMA_REGIONS : CATALOG_SCHEMA;
}

/** The canonical bytes of a catalog (stable key order, 2-space JSON, trailing newline): what is signed. */
export function serializeCatalog(catalog: Catalog): Uint8Array {
  const revoked = catalog.revoked && catalog.revoked.length > 0 ? { revoked: [...catalog.revoked].sort() } : {};
  const ordered: Catalog = { schema: catalogSchema(catalog.packs), sequence: catalog.sequence, issuedAt: catalog.issuedAt, keyId: catalog.keyId, packs: catalog.packs, ...revoked };
  parseCatalog(ordered);
  return utf8(`${JSON.stringify(ordered, null, 2)}\n`);
}

/** Serialises a catalog and signs the exact bytes. */
export function signCatalog(catalog: Catalog, key: SigningKey): Signed {
  const bytes = serializeCatalog({ ...catalog, keyId: key.keyId });
  return { bytes, signature: signBytes(bytes, key.secretKey) };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Measures the packs and returns the exact catalog bytes to be signed later by `keyId`, without any
 * key: the maintainer reviews these bytes (and their SHA-256) and signs them on the offline machine.
 */
export async function prepareCatalog(opts: PrepareOptions): Promise<{ bytes: Uint8Array; catalog: Catalog }> {
  const sequence = nextSequence(opts.previousSequence, opts.sequence);
  const packs = await measurePacks(opts);
  const catalog: Catalog = {
    schema: catalogSchema(packs),
    sequence,
    issuedAt: opts.issuedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    keyId: opts.keyId,
    packs,
    ...(opts.revoked && opts.revoked.length > 0 ? { revoked: opts.revoked.map((h) => h.toLowerCase()) } : {}),
  };
  return { bytes: serializeCatalog(catalog), catalog };
}

export async function buildCatalog(opts: BuildOptions): Promise<Signed & { catalog: Catalog }> {
  const { bytes, catalog } = await prepareCatalog({ ...opts, keyId: opts.key.keyId });
  return { bytes, signature: signBytes(bytes, opts.key.secretKey), catalog };
}

export interface SignPreparedOptions {
  /** Sequence of the catalog this one replaces (e.g. the embedded release catalog). */
  previousSequence: number | null;
  /** SHA-256 the maintainer reviewed: signing is refused when the bytes differ. */
  expectSha256?: string;
}

/**
 * Signs prepared catalog bytes exactly as they are. Refuses bytes that are not a valid catalog in the
 * canonical form, name another key, do not increase the sequence, or differ from the reviewed hash.
 */
export function signPreparedCatalog(bytes: Uint8Array, key: SigningKey, opts: SignPreparedOptions): Signed & { catalog: Catalog; sha256: string } {
  const sha256 = sha256Hex(bytes);
  if (opts.expectSha256 !== undefined && opts.expectSha256.toLowerCase() !== sha256) {
    throw new Error(`catalog bytes have SHA-256 ${sha256}, not the reviewed ${opts.expectSha256}`);
  }
  const catalog = parseCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
  if (catalog.keyId !== key.keyId) throw new Error(`the catalog names key ${catalog.keyId}, not ${key.keyId}`);
  if (sha256Hex(serializeCatalog(catalog)) !== sha256) throw new Error('the catalog bytes are not in the canonical form written by prepare');
  nextSequence(opts.previousSequence, catalog.sequence);
  return { bytes, signature: signBytes(bytes, key.secretKey), catalog, sha256 };
}

/**
 * Key rotation: a key list signed by the key it replaces (or the offline backup). The app accepts
 * it only when the signer is trusted, then trusts exactly the listed keys.
 */
export function signKeyList(list: Omit<KeyList, 'schema' | 'signedBy'>, signer: SigningKey): Signed {
  const ordered: KeyList = { schema: KEY_LIST_SCHEMA, sequence: list.sequence, issuedAt: list.issuedAt, signedBy: signer.keyId, keys: list.keys };
  parseKeyList(ordered);
  const bytes = utf8(`${JSON.stringify(ordered, null, 2)}\n`);
  return { bytes, signature: signBytes(bytes, signer.secretKey) };
}

export async function writeSigned(dir: string, name: string, signed: Signed): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), signed.bytes);
  await writeFile(join(dir, `${name}.sig`), `${signed.signature}\n`, 'utf8');
}

/** Verifies `<dir>/catalog.json` + `.sig` with the given keys (same code as the app). */
export function verifyCatalogDir(dir: string, trusted: readonly TrustedKey[]): ReturnType<typeof verifyCatalog> {
  const bytes = new Uint8Array(readFileSync(join(dir, 'catalog.json')));
  const sig = readFileSync(join(dir, 'catalog.json.sig'), 'utf8');
  return verifyCatalog(bytes, sig, trusted, { sequence: null, sha256: null });
}

export function verifyKeyListDir(dir: string, trusted: readonly TrustedKey[]): ReturnType<typeof verifyKeyList> {
  const bytes = new Uint8Array(readFileSync(join(dir, 'keys.json')));
  const sig = readFileSync(join(dir, 'keys.json.sig'), 'utf8');
  return verifyKeyList(bytes, sig, trusted, { sequence: null, sha256: null });
}
