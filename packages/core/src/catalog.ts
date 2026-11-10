import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

// The synchronous Ed25519 API needs a SHA-512 provider (noble v3).
ed.hashes.sha512 = sha512;

/**
 * Signed content catalog (docs/architecture.md, "Content pipeline"). Every file the app opens maps to
 * an entry with its SHA-256; the catalog itself is trusted only through an Ed25519 signature over its
 * exact bytes, made by a pinned key (or a key introduced by a key list signed by a pinned key), and
 * only when its `sequence` is not lower than the highest one the device has accepted (anti-rollback;
 * no wall-clock time is involved, so it works offline).
 */
export const CATALOG_SCHEMA = 1;
/**
 * Schema 2 (global maps, 2026-10-23): map and places packs may carry `region` (country, bounding box,
 * part of a split country). Apps before it reject a schema 2 catalog as a whole (strict schema) and keep
 * the catalog they have, so a country pack never reaches an app that would render only one map.
 */
export const CATALOG_SCHEMA_REGIONS = 2;
export const CATALOG_SCHEMAS = [CATALOG_SCHEMA, CATALOG_SCHEMA_REGIONS] as const;
export type CatalogSchema = (typeof CATALOG_SCHEMAS)[number];
export const KEY_LIST_SCHEMA = 1;
/** Chunk size of `chunkSha256` (P2P re-requests a bad chunk alone). */
export const CATALOG_CHUNK_SIZE = 64 * 1024 * 1024;

export type PackKind = 'zim' | 'gguf' | 'pmtiles' | 'places';
export type CatalogTier = 'T0' | 'T1' | 'T2' | 'T3';

/**
 * West, south, east, north in degrees (WGS 84). West > east means the box crosses the antimeridian
 * (United States, Russia, Fiji: the smallest box around the country).
 */
export type BBoxTuple = [number, number, number, number];

/** The country of a map or places pack (catalog schema 2). Every pack of a country has the same one. */
export interface PackRegion {
  /** ISO 3166-1 alpha-2, upper case. */
  iso2: string;
  /** English country name (Natural Earth). */
  name: string;
  /** The country's bounding box (for a part too). */
  bbox: BBoxTuple;
  /** Where a map of the country opens: [longitude, latitude] (Natural Earth label point). */
  center: [number, number];
  /** One part of a country split into several map packs (groups of first-level subdivisions). */
  part?: RegionPart;
}

/** A part of a split country: the first-level subdivisions (Natural Earth admin-1) its map covers. */
export interface RegionPart {
  id: string;
  /** Every group the part covers (subdivisions, or regions of them), e.g. "Bavaria, Thuringia". */
  name: string;
  /** English and local names of every subdivision and region in the part (search: "Bayern"). */
  regions: string[];
  /** The part's own bounding box (where the map opens when only some parts are installed). */
  bbox: BBoxTuple;
}

export interface CatalogPack {
  id: string;
  kind: PackKind;
  version: string;
  /** File name on disk (`zim/<file>`, `models/<file>`, …). */
  file: string;
  title: { en: string; el?: string };
  lang: string[];
  sizeBytes: number;
  sha256: string;
  chunkSize: number;
  chunkSha256: string[];
  /** HTTPS mirrors in order of preference; no query strings or fragments. */
  urls: string[];
  license: string;
  attribution: string;
  minTier: CatalogTier;
  tags: string[];
  /** Schema 2 only, map and places packs only. */
  region?: PackRegion;
}

export interface Catalog {
  schema: CatalogSchema;
  sequence: number;
  issuedAt: string;
  keyId: string;
  packs: CatalogPack[];
  /**
   * SHA-256 of pack files that are no longer trusted (optional; architecture "Pack trust across catalogs").
   * A pack an older signed catalog verified loses its verified state when its hash is listed here. Apps
   * before this field reject such a catalog as a whole (strict schema) and keep theirs.
   */
  revoked?: string[];
}

export interface TrustedKey {
  keyId: string;
  /** 32-byte Ed25519 public key. */
  publicKey: Uint8Array;
}

/** Keys pinned in the app: one active, one offline backup (architecture: key rotation). */
export interface PinnedKeys {
  active: TrustedKey;
  backup: TrustedKey;
}

export interface KeyList {
  schema: typeof KEY_LIST_SCHEMA;
  sequence: number;
  issuedAt: string;
  /** Key that signed this list; must be trusted before the list is accepted. */
  signedBy: string;
  keys: { keyId: string; publicKey: string; role: 'active' | 'backup' }[];
}

export type CatalogRejection = 'malformed' | 'schema' | 'unknown_key' | 'bad_signature' | 'rollback' | 'sequence_reuse';

export type Verified<T> =
  | { ok: true; value: T; sequence: number; sha256: string }
  | { ok: false; reason: CatalogRejection; detail: string };

const HEX64 = /^[0-9a-f]{64}$/;
const PACK_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ISO2 = /^[A-Z]{2}$/;
const PART_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DOWNLOAD_URL = /^https:\/\/([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?(\/[A-Za-z0-9._~!$&'()*+,;=:%/-]*)?$/;
const EXTENSIONS: Readonly<Record<PackKind, string>> = { zim: '.zim', gguf: '.gguf', pmtiles: '.pmtiles', places: '.sqlite' };
const KINDS = Object.keys(EXTENSIONS) as PackKind[];
const TIERS: readonly CatalogTier[] = ['T0', 'T1', 'T2', 'T3'];

// ---- encoding helpers (no Buffer: the same code runs on Hermes and Node) ----

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63);
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '=';
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '=';
  }
  return out;
}

/** Strict base64 (standard alphabet, padded); throws on anything else. */
export function fromBase64(text: string): Uint8Array {
  const s = text.trim();
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error('invalid base64');
  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k += 1) {
      const ch = s.charAt(i + k);
      n = (n << 6) | (ch === '=' ? 0 : B64.indexOf(ch));
    }
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

// ---- schema validation ----

class SchemaError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, path: string, re?: RegExp): string {
  if (typeof v !== 'string' || v.length === 0 || (re && !re.test(v))) throw new SchemaError(`${path}: invalid`);
  return v;
}

function int(v: unknown, path: string, min: number): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) throw new SchemaError(`${path}: expected an integer ≥ ${min}`);
  return v;
}

function strings(v: unknown, path: string, minItems: number): string[] {
  if (!Array.isArray(v) || v.length < minItems) throw new SchemaError(`${path}: expected at least ${minItems} item(s)`);
  return v.map((x, i) => str(x, `${path}[${String(i)}]`));
}

function noExtraKeys(o: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw new SchemaError(`${path}: unexpected field(s) ${extra.join(', ')}`);
}

/** HTTPS only; no credentials, query string or fragment (architecture: privacy of download requests). */
export function isAllowedDownloadUrl(url: string): boolean {
  return DOWNLOAD_URL.test(url);
}

const PACK_FIELDS = [
  'id', 'kind', 'version', 'file', 'title', 'lang', 'sizeBytes', 'sha256', 'chunkSize', 'chunkSha256', 'urls', 'license',
  'attribution', 'minTier', 'tags',
] as const;
const PACK_FIELDS_REGIONS = [...PACK_FIELDS, 'region'] as const;

function coordinate(v: unknown, path: string, limit: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > limit) throw new SchemaError(`${path}: invalid`);
  return v;
}

function parseBBox(v: unknown, path: string): BBoxTuple {
  if (!Array.isArray(v) || v.length !== 4) throw new SchemaError(`${path}: expected [west, south, east, north]`);
  const bbox: BBoxTuple = [coordinate(v[0], `${path}[0]`, 180), coordinate(v[1], `${path}[1]`, 90), coordinate(v[2], `${path}[2]`, 180), coordinate(v[3], `${path}[3]`, 90)];
  if (bbox[0] === bbox[2] || bbox[1] >= bbox[3]) throw new SchemaError(`${path}: expected west ≠ east and south < north`);
  return bbox;
}

/** A split country has at most a few hundred subdivision names per part (Italy: 110 provinces). */
const PART_REGIONS_MAX = 500;

function parsePart(v: unknown, path: string): RegionPart {
  if (!isRecord(v)) throw new SchemaError(`${path}: expected an object`);
  noExtraKeys(v, ['id', 'name', 'regions', 'bbox'], path);
  if (!Array.isArray(v.regions) || v.regions.length === 0 || v.regions.length > PART_REGIONS_MAX) {
    throw new SchemaError(`${path}.regions: expected 1–${String(PART_REGIONS_MAX)} names`);
  }
  const regions = v.regions.map((r, i) => str(r, `${path}.regions[${String(i)}]`));
  return { id: str(v.id, `${path}.id`, PART_ID), name: str(v.name, `${path}.name`), regions, bbox: parseBBox(v.bbox, `${path}.bbox`) };
}

function parseRegion(v: unknown, path: string): PackRegion {
  if (!isRecord(v)) throw new SchemaError(`${path}: expected an object`);
  noExtraKeys(v, ['iso2', 'name', 'bbox', 'center', 'part'], path);
  const bbox = parseBBox(v.bbox, `${path}.bbox`);
  if (!Array.isArray(v.center) || v.center.length !== 2) throw new SchemaError(`${path}.center: expected [longitude, latitude]`);
  const center: [number, number] = [coordinate(v.center[0], `${path}.center[0]`, 180), coordinate(v.center[1], `${path}.center[1]`, 90)];
  const region: PackRegion = { iso2: str(v.iso2, `${path}.iso2`, ISO2), name: str(v.name, `${path}.name`), bbox, center };
  if (v.part !== undefined) region.part = parsePart(v.part, `${path}.part`);
  return region;
}

function parsePack(v: unknown, path: string, schema: CatalogSchema): CatalogPack {
  if (!isRecord(v)) throw new SchemaError(`${path}: expected an object`);
  noExtraKeys(v, schema === CATALOG_SCHEMA_REGIONS ? PACK_FIELDS_REGIONS : PACK_FIELDS, path);
  const kind = KINDS.find((k) => k === v.kind);
  if (!kind) throw new SchemaError(`${path}.kind: invalid`);
  const file = str(v.file, `${path}.file`, FILE_NAME);
  if (!file.toLowerCase().endsWith(EXTENSIONS[kind])) throw new SchemaError(`${path}.file: expected a ${EXTENSIONS[kind]} file`);
  if (!isRecord(v.title)) throw new SchemaError(`${path}.title: expected an object`);
  noExtraKeys(v.title, ['en', 'el'], `${path}.title`);
  const title: CatalogPack['title'] = { en: str(v.title.en, `${path}.title.en`) };
  if (v.title.el !== undefined) title.el = str(v.title.el, `${path}.title.el`);
  const sizeBytes = int(v.sizeBytes, `${path}.sizeBytes`, 1);
  const chunkSize = int(v.chunkSize, `${path}.chunkSize`, 1);
  const chunkSha256 = strings(v.chunkSha256, `${path}.chunkSha256`, 1);
  if (chunkSha256.length !== Math.ceil(sizeBytes / chunkSize)) throw new SchemaError(`${path}.chunkSha256: wrong number of chunks`);
  chunkSha256.forEach((h, i) => str(h, `${path}.chunkSha256[${String(i)}]`, HEX64));
  const urls = strings(v.urls, `${path}.urls`, 1);
  urls.forEach((u, i) => {
    if (!isAllowedDownloadUrl(u)) throw new SchemaError(`${path}.urls[${String(i)}]: HTTPS without query string required`);
  });
  const minTier = TIERS.find((t) => t === v.minTier);
  if (!minTier) throw new SchemaError(`${path}.minTier: invalid`);
  const pack: CatalogPack = {
    id: str(v.id, `${path}.id`, PACK_ID),
    kind,
    version: str(v.version, `${path}.version`),
    file,
    title,
    lang: strings(v.lang, `${path}.lang`, 1),
    sizeBytes,
    sha256: str(v.sha256, `${path}.sha256`, HEX64),
    chunkSize,
    chunkSha256,
    urls,
    license: str(v.license, `${path}.license`),
    attribution: str(v.attribution, `${path}.attribution`),
    minTier,
    tags: strings(v.tags, `${path}.tags`, 0),
  };
  if (v.region !== undefined) {
    if (kind !== 'pmtiles' && kind !== 'places') throw new SchemaError(`${path}.region: only map and places packs have a region`);
    pack.region = parseRegion(v.region, `${path}.region`);
  }
  return pack;
}

/** Validates a parsed catalog; throws with the path of the first invalid field. */
export function parseCatalog(data: unknown): Catalog {
  if (!isRecord(data)) throw new SchemaError('catalog: expected an object');
  noExtraKeys(data, ['schema', 'sequence', 'issuedAt', 'keyId', 'packs', 'revoked'], 'catalog');
  const schema = CATALOG_SCHEMAS.find((n) => n === data.schema);
  if (schema === undefined) throw new SchemaError(`catalog.schema: expected ${CATALOG_SCHEMAS.join(' or ')}`);
  if (!Array.isArray(data.packs)) throw new SchemaError('catalog.packs: expected an array');
  const packs = data.packs.map((p, i) => parsePack(p, `catalog.packs[${String(i)}]`, schema));
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const p of packs) {
    if (ids.has(p.id)) throw new SchemaError(`catalog.packs: duplicate id ${p.id}`);
    if (files.has(`${p.kind}/${p.file}`)) throw new SchemaError(`catalog.packs: duplicate file ${p.file}`);
    ids.add(p.id);
    files.add(`${p.kind}/${p.file}`);
  }
  const revoked = data.revoked === undefined ? undefined : parseRevoked(data.revoked, packs);
  return {
    schema,
    sequence: int(data.sequence, 'catalog.sequence', 1),
    issuedAt: str(data.issuedAt, 'catalog.issuedAt'),
    keyId: str(data.keyId, 'catalog.keyId', KEY_ID),
    packs,
    ...(revoked ? { revoked } : {}),
  };
}

function parseRevoked(v: unknown, packs: readonly CatalogPack[]): string[] {
  if (!Array.isArray(v)) throw new SchemaError('catalog.revoked: expected an array');
  const listed = new Set(packs.map((p) => p.sha256));
  const seen = new Set<string>();
  return v.map((h, i) => {
    const path = `catalog.revoked[${String(i)}]`;
    const sha = str(h, path, HEX64);
    if (seen.has(sha)) throw new SchemaError(`catalog.revoked: duplicate ${sha}`);
    if (listed.has(sha)) throw new SchemaError(`${path}: a listed pack has this hash`);
    seen.add(sha);
    return sha;
  });
}

/**
 * How an installed pack is trusted under the current catalog: `verified-older` is a pack an older signed
 * catalog verified that the current one lists in another version (still trusted; the user can update it).
 */
export function packTrust(
  catalog: { packs: readonly { sha256: string }[]; revoked?: readonly string[] } | null,
  pack: { verified: boolean; sha256: string },
): 'verified' | 'verified-older' | 'unverified' {
  const sha = pack.sha256.toLowerCase();
  if (!pack.verified || catalog?.revoked?.includes(sha)) return 'unverified';
  if (catalog && !catalog.packs.some((p) => p.sha256 === sha)) return 'verified-older';
  return 'verified';
}

/** True when the catalog withdraws trust from files with this SHA-256. */
export function isRevoked(catalog: Catalog, digest: string): boolean {
  return catalog.revoked?.includes(digest.toLowerCase()) ?? false;
}

function decodeKey(b64: string): Uint8Array | null {
  try {
    const k = fromBase64(b64);
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

export function parseKeyList(data: unknown): KeyList {
  if (!isRecord(data)) throw new SchemaError('keys: expected an object');
  noExtraKeys(data, ['schema', 'sequence', 'issuedAt', 'signedBy', 'keys'], 'keys');
  if (data.schema !== KEY_LIST_SCHEMA) throw new SchemaError(`keys.schema: expected ${String(KEY_LIST_SCHEMA)}`);
  if (!Array.isArray(data.keys) || data.keys.length === 0) throw new SchemaError('keys.keys: expected at least one key');
  const keys = data.keys.map((k, i) => {
    const path = `keys.keys[${String(i)}]`;
    if (!isRecord(k)) throw new SchemaError(`${path}: expected an object`);
    noExtraKeys(k, ['keyId', 'publicKey', 'role'], path);
    const role: KeyList['keys'][number]['role'] | null = k.role === 'active' || k.role === 'backup' ? k.role : null;
    if (!role) throw new SchemaError(`${path}.role: invalid`);
    const publicKey = str(k.publicKey, `${path}.publicKey`);
    if (decodeKey(publicKey) === null) throw new SchemaError(`${path}.publicKey: expected 32 bytes (base64)`);
    return { keyId: str(k.keyId, `${path}.keyId`, KEY_ID), publicKey, role };
  });
  if (keys.filter((k) => k.role === 'active').length !== 1) throw new SchemaError('keys.keys: exactly one active key required');
  return {
    schema: KEY_LIST_SCHEMA,
    sequence: int(data.sequence, 'keys.sequence', 1),
    issuedAt: str(data.issuedAt, 'keys.issuedAt'),
    signedBy: str(data.signedBy, 'keys.signedBy', KEY_ID),
    keys,
  };
}

/** Decodes a `.sig` file: base64 of the 64-byte Ed25519 signature (whitespace ignored). */
export function decodeSignature(text: string): Uint8Array | null {
  try {
    const s = fromBase64(text.replace(/\s+/g, ''));
    return s.length === 64 ? s : null;
  } catch {
    return null;
  }
}

function verifyBytes(bytes: Uint8Array, signature: string, key: TrustedKey): boolean {
  const sig = decodeSignature(signature);
  if (!sig) return false;
  return ed.verify(sig, bytes, key.publicKey, { zip215: false });
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
}

export interface SequenceState {
  /** Highest sequence accepted so far on this device (null on first start). */
  sequence: number | null;
  /** SHA-256 of the document accepted with that sequence. */
  sha256: string | null;
}

export const NO_SEQUENCE: SequenceState = { sequence: null, sha256: null };

function checkSequence(sequence: number, digest: string, state: SequenceState): { reason: CatalogRejection; detail: string } | null {
  if (state.sequence === null) return null;
  if (sequence < state.sequence) return { reason: 'rollback', detail: `sequence ${String(sequence)} < accepted ${String(state.sequence)}` };
  if (sequence === state.sequence && state.sha256 !== null && state.sha256 !== digest) {
    return { reason: 'sequence_reuse', detail: `sequence ${String(sequence)} already accepted with different content` };
  }
  return null;
}

function malformed(e: unknown): { ok: false; reason: CatalogRejection; detail: string } {
  return { ok: false, reason: 'malformed', detail: e instanceof Error ? e.message : String(e) };
}

/**
 * Verifies a catalog: signature over the exact bytes by the trusted key named in `keyId` (nothing in
 * the document is used before that), then the schema, then anti-rollback against the stored state.
 */
export function verifyCatalog(bytes: Uint8Array, signature: string, trusted: readonly TrustedKey[], state: SequenceState): Verified<Catalog> {
  let data: unknown;
  try {
    data = parseJson(bytes);
  } catch (e) {
    return malformed(e);
  }
  const keyId = isRecord(data) && typeof data.keyId === 'string' ? data.keyId : '';
  const key = trusted.find((k) => k.keyId === keyId);
  if (!key) return { ok: false, reason: 'unknown_key', detail: `key "${keyId}" is not trusted` };
  if (!verifyBytes(bytes, signature, key)) return { ok: false, reason: 'bad_signature', detail: `signature does not verify with ${keyId}` };
  let catalog: Catalog;
  try {
    catalog = parseCatalog(data);
  } catch (e) {
    return { ok: false, reason: 'schema', detail: e instanceof Error ? e.message : String(e) };
  }
  const digest = sha256Hex(bytes);
  const seq = checkSequence(catalog.sequence, digest, state);
  if (seq) return { ok: false, ...seq };
  return { ok: true, value: catalog, sequence: catalog.sequence, sha256: digest };
}

/**
 * Verifies a key list (rotation): it must be signed by a currently trusted key (the previous active
 * key, or the offline backup after a compromise) and must not roll back. On success its keys replace
 * the trusted set.
 */
export function verifyKeyList(
  bytes: Uint8Array,
  signature: string,
  trusted: readonly TrustedKey[],
  state: SequenceState,
): Verified<{ list: KeyList; keys: TrustedKey[] }> {
  let data: unknown;
  try {
    data = parseJson(bytes);
  } catch (e) {
    return malformed(e);
  }
  const signer = isRecord(data) && typeof data.signedBy === 'string' ? data.signedBy : '';
  const key = trusted.find((k) => k.keyId === signer);
  if (!key) return { ok: false, reason: 'unknown_key', detail: `signer "${signer}" is not trusted` };
  if (!verifyBytes(bytes, signature, key)) return { ok: false, reason: 'bad_signature', detail: `signature does not verify with ${signer}` };
  let list: KeyList;
  try {
    list = parseKeyList(data);
  } catch (e) {
    return { ok: false, reason: 'schema', detail: e instanceof Error ? e.message : String(e) };
  }
  const digest = sha256Hex(bytes);
  const seq = checkSequence(list.sequence, digest, state);
  if (seq) return { ok: false, ...seq };
  const keys = list.keys.flatMap((k) => {
    const publicKey = decodeKey(k.publicKey);
    return publicKey ? [{ keyId: k.keyId, publicKey }] : [];
  });
  return { ok: true, value: { list, keys }, sequence: list.sequence, sha256: digest };
}

export interface PinnedKeyInput {
  keyId: string;
  publicKey: string;
}

/** Pinned keys from their base64 form (as embedded in the app); throws on a malformed key. */
export function pinnedKeys(input: { active: PinnedKeyInput; backup: PinnedKeyInput }): PinnedKeys {
  const decode = (k: PinnedKeyInput): TrustedKey => {
    const publicKey = decodeKey(k.publicKey);
    if (!publicKey || !KEY_ID.test(k.keyId)) throw new Error(`invalid pinned key ${k.keyId}`);
    return { keyId: k.keyId, publicKey };
  };
  return { active: decode(input.active), backup: decode(input.backup) };
}

export function trustedFromPinned(pinned: PinnedKeys): TrustedKey[] {
  return [pinned.active, pinned.backup];
}

/** The catalog entry for a file, by its SHA-256 (import, P2P, provisioned files). */
export function findPackBySha256(catalog: Catalog, digest: string): CatalogPack | null {
  const d = digest.toLowerCase();
  return catalog.packs.find((p) => p.sha256 === d) ?? null;
}

/** Signs bytes (catalog-builder and tests only; the app never holds a secret key). */
export function signBytes(bytes: Uint8Array, secretKey: Uint8Array): string {
  return toBase64(ed.sign(bytes, secretKey));
}

export function generateKeyPair(): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey, publicKey };
}

export function publicKeyOf(secretKey: Uint8Array): Uint8Array {
  return ed.getPublicKey(secretKey);
}
