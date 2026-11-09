import { describe, expect, it } from 'vitest';
import {
  CATALOG_CHUNK_SIZE,
  findPackBySha256,
  fromBase64,
  generateKeyPair,
  isAllowedDownloadUrl,
  NO_SEQUENCE,
  parseCatalog,
  pinnedKeys,
  sha256Hex,
  signBytes,
  toBase64,
  trustedFromPinned,
  utf8,
  verifyCatalog,
  verifyKeyList,
  type Catalog,
  type TrustedKey,
} from '../src/catalog';

const H = (c: string): string => c.repeat(64);

function catalog(over: Partial<Catalog> = {}, keyId = 'cat-test-a'): Catalog {
  return {
    schema: 1,
    sequence: 5,
    issuedAt: '2026-10-05T00:00:00Z',
    keyId,
    packs: [
      {
        id: 'wikipedia_en_top_mini',
        kind: 'zim',
        version: '2026-09',
        file: 'wikipedia_en_top_mini_2026-09.zim',
        title: { en: 'Wikipedia top articles (mini)', el: 'Wikipedia κορυφαία άρθρα' },
        lang: ['en'],
        sizeBytes: CATALOG_CHUNK_SIZE + 10,
        sha256: H('a'),
        chunkSize: CATALOG_CHUNK_SIZE,
        chunkSha256: [H('b'), H('c')],
        urls: ['https://download.kiwix.org/zim/wikipedia/wikipedia_en_top_mini_2026-09.zim'],
        license: 'CC-BY-SA-4.0',
        attribution: 'Wikipedia contributors',
        minTier: 'T0',
        tags: ['encyclopedia'],
      },
    ],
    ...over,
  };
}

const keyA = generateKeyPair();
const keyB = generateKeyPair();
const keyC = generateKeyPair();
const pinned = pinnedKeys({
  active: { keyId: 'cat-test-a', publicKey: toBase64(keyA.publicKey) },
  backup: { keyId: 'cat-test-b', publicKey: toBase64(keyB.publicKey) },
});
const trusted = trustedFromPinned(pinned);

function signed(c: unknown, secretKey: Uint8Array): { bytes: Uint8Array; sig: string } {
  const bytes = utf8(`${JSON.stringify(c, null, 2)}\n`);
  return { bytes, sig: signBytes(bytes, secretKey) };
}

function flip(bytes: Uint8Array, at: number): Uint8Array {
  const out = new Uint8Array(bytes);
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
}

describe('verifyCatalog', () => {
  it('accepts a catalog signed by the pinned active key and reports its sequence and hash', () => {
    const { bytes, sig } = signed(catalog(), keyA.secretKey);
    const r = verifyCatalog(bytes, sig, trusted, NO_SEQUENCE);
    expect(r).toMatchObject({ ok: true, sequence: 5, sha256: sha256Hex(bytes) });
    if (r.ok) expect(findPackBySha256(r.value, H('a').toUpperCase())?.id).toBe('wikipedia_en_top_mini');
  });

  it('accepts the backup key', () => {
    const { bytes, sig } = signed(catalog({}, 'cat-test-b'), keyB.secretKey);
    expect(verifyCatalog(bytes, sig, trusted, NO_SEQUENCE).ok).toBe(true);
  });

  it('rejects a single tampered byte anywhere in the file', () => {
    const { bytes, sig } = signed(catalog(), keyA.secretKey);
    for (const at of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
      const r = verifyCatalog(flip(bytes, at), sig, trusted, NO_SEQUENCE);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(['bad_signature', 'malformed', 'unknown_key']).toContain(r.reason);
    }
    // The same JSON serialised differently is a different byte string: also rejected.
    const compact = utf8(JSON.stringify(catalog()));
    expect(verifyCatalog(compact, sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'bad_signature' });
    // A tampered signature as well.
    const badSig = toBase64(flip(fromBase64(sig), 10));
    expect(verifyCatalog(bytes, badSig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature by a key that is not pinned, even when the catalog claims a pinned key id', () => {
    const { bytes, sig } = signed(catalog(), keyC.secretKey);
    expect(verifyCatalog(bytes, sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const other = signed(catalog({}, 'cat-rogue'), keyC.secretKey);
    expect(verifyCatalog(other.bytes, other.sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'unknown_key' });
  });

  it('rejects garbage signatures and malformed bytes', () => {
    const { bytes } = signed(catalog(), keyA.secretKey);
    expect(verifyCatalog(bytes, 'not base64!', trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'bad_signature' });
    expect(verifyCatalog(utf8('{"keyId":'), 'AAAA', trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyCatalog(new Uint8Array([0xff, 0xfe]), 'AAAA', trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('rejects a lower sequence (rollback) and a reused sequence with other content', () => {
    const lower = signed(catalog({ sequence: 4 }), keyA.secretKey);
    expect(verifyCatalog(lower.bytes, lower.sig, trusted, { sequence: 5, sha256: H('d') })).toMatchObject({ ok: false, reason: 'rollback' });
    const same = signed(catalog({ sequence: 5 }), keyA.secretKey);
    expect(verifyCatalog(same.bytes, same.sig, trusted, { sequence: 5, sha256: H('d') })).toMatchObject({ ok: false, reason: 'sequence_reuse' });
    expect(verifyCatalog(same.bytes, same.sig, trusted, { sequence: 5, sha256: sha256Hex(same.bytes) }).ok).toBe(true);
    const newer = signed(catalog({ sequence: 6 }), keyA.secretKey);
    expect(verifyCatalog(newer.bytes, newer.sig, trusted, { sequence: 5, sha256: H('d') }).ok).toBe(true);
  });

  it('rejects a signed catalog that breaks the schema', () => {
    const bad = (over: Record<string, unknown>): string => {
      const c = catalog();
      const { bytes, sig } = signed({ ...c, packs: [{ ...c.packs[0], ...over }] }, keyA.secretKey);
      const r = verifyCatalog(bytes, sig, trusted, NO_SEQUENCE);
      return r.ok ? 'ok' : r.reason;
    };
    expect(bad({})).toBe('ok');
    expect(bad({ urls: ['http://download.kiwix.org/x.zim'] })).toBe('schema');
    expect(bad({ urls: ['https://mirror.example/x.zim?token=1'] })).toBe('schema');
    expect(bad({ chunkSha256: [H('b')] })).toBe('schema');
    expect(bad({ sha256: 'ABC' })).toBe('schema');
    expect(bad({ file: '../../etc/passwd.zim' })).toBe('schema');
    expect(bad({ file: 'model.gguf' })).toBe('schema');
    expect(bad({ extra: 1 })).toBe('schema');
  });
});

describe('catalog schema 2 (global maps: pack regions)', () => {
  const MAP = {
    id: 'map-cy',
    kind: 'pmtiles',
    version: '2026-10-22',
    file: 'map-cy-20261022.pmtiles',
    title: { en: 'Map: Cyprus' },
    lang: ['en'],
    sizeBytes: 10,
    sha256: H('e'),
    chunkSize: CATALOG_CHUNK_SIZE,
    chunkSha256: [H('e')],
    urls: ['https://github.com/anywecon/skepi/releases/download/packs-2026-10b/map-cy-20261022.pmtiles'],
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors',
    minTier: 'T0',
    tags: ['map', 'region:CY'],
    region: { iso2: 'CY', name: 'Cyprus', bbox: [32.2225, 34.5224, 34.642, 35.7405], center: [33.0842, 34.9133] },
  };
  const verify = (schema: number, packs: Record<string, unknown>[]): string => {
    const { bytes, sig } = signed({ ...catalog(), schema, packs }, keyA.secretKey);
    const r = verifyCatalog(bytes, sig, trusted, NO_SEQUENCE);
    return r.ok ? 'ok' : `${r.reason}: ${r.detail}`;
  };

  it('accepts regions in a schema 2 catalog and keeps schema 1 catalogs valid', () => {
    expect(verify(2, [MAP])).toBe('ok');
    expect(verify(2, [catalog().packs[0] as unknown as Record<string, unknown>])).toBe('ok');
    expect(verify(1, [catalog().packs[0] as unknown as Record<string, unknown>])).toBe('ok');
    const parsed = parseCatalog({ ...catalog(), schema: 2, packs: [MAP] });
    expect(parsed.schema).toBe(2);
    expect(parsed.packs[0]?.region).toEqual(MAP.region);
  });

  it('a split country part and a box across the antimeridian', () => {
    const part = { id: 'alaska', name: 'Alaska, Oregon', regions: ['Alaska', 'Oregon'], bbox: [172.4262, 41.9, -116.4, 71.4605] };
    const us = { iso2: 'US', name: 'United States of America', bbox: [172.4262, 18.8564, -66.9282, 71.4605], center: [-97.4826, 39.5385], part };
    expect(verify(2, [{ ...MAP, id: 'map-us-alaska', file: 'map-us-alaska.pmtiles', region: us }])).toBe('ok');
    expect(parseCatalog({ ...catalog(), schema: 2, packs: [{ ...MAP, id: 'map-us-alaska', file: 'map-us-alaska.pmtiles', region: us }] }).packs[0]?.region?.part).toEqual(part);
  });

  it('rejects a region in a schema 1 catalog (what apps before schema 2 see) and unknown schemas', () => {
    expect(verify(1, [MAP])).toMatch(/^schema: .*unexpected field\(s\) region/);
    expect(verify(3, [MAP])).toMatch(/^schema: catalog\.schema: expected 1 or 2/);
  });

  it('rejects malformed regions', () => {
    const bad = (region: unknown): string => verify(2, [{ ...MAP, region }]);
    expect(bad({ ...MAP.region, iso2: 'cy' })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, bbox: [32, 34, 34] })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, bbox: [32, 36, 34, 35] })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, bbox: [32, 34, 32, 35] })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, bbox: [190, 34, 34, 35] })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, center: [33] })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, center: undefined })).toMatch(/^schema/);
    const part = { id: 'west', name: 'West', regions: ['West'], bbox: [32, 34, 33, 35] };
    expect(bad({ ...MAP.region, part })).toBe('ok');
    expect(bad({ ...MAP.region, part: { ...part, id: 'West' } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { id: 'west', name: 'West' } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { ...part, regions: [] } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { ...part, regions: [''] } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { ...part, regions: Array.from({ length: 501 }, (_, i) => `R${String(i)}`) } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { ...part, bbox: [32, 35, 33, 34] } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, part: { ...part, extra: 1 } })).toMatch(/^schema/);
    expect(bad({ ...MAP.region, extra: true })).toMatch(/^schema/);
    expect(verify(2, [{ ...(catalog().packs[0] as unknown as Record<string, unknown>), region: MAP.region }])).toMatch(/only map and places packs/);
  });
});

describe('verifyKeyList (rotation)', () => {
  const keyD = generateKeyPair();
  const list = (signedBy: string, sequence = 2): Record<string, unknown> => ({
    schema: 1,
    sequence,
    issuedAt: '2027-01-01T00:00:00Z',
    signedBy,
    keys: [
      { keyId: 'cat-test-d', publicKey: toBase64(keyD.publicKey), role: 'active' },
      { keyId: 'cat-test-b', publicKey: toBase64(keyB.publicKey), role: 'backup' },
    ],
  });

  it('accepts a key list signed by the previous key, after which catalogs by the new key verify', () => {
    const { bytes, sig } = signed(list('cat-test-a'), keyA.secretKey);
    const r = verifyKeyList(bytes, sig, trusted, NO_SEQUENCE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const next: TrustedKey[] = r.value.keys;
    expect(next.map((k) => k.keyId)).toEqual(['cat-test-d', 'cat-test-b']);
    const c = signed(catalog({ sequence: 7 }, 'cat-test-d'), keyD.secretKey);
    expect(verifyCatalog(c.bytes, c.sig, next, NO_SEQUENCE).ok).toBe(true);
    // The retired key is no longer trusted.
    const old = signed(catalog({ sequence: 8 }), keyA.secretKey);
    expect(verifyCatalog(old.bytes, old.sig, next, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'unknown_key' });
  });

  it('accepts a list signed by the offline backup key (active key lost or compromised)', () => {
    const { bytes, sig } = signed(list('cat-test-b'), keyB.secretKey);
    expect(verifyKeyList(bytes, sig, trusted, NO_SEQUENCE).ok).toBe(true);
  });

  it('rejects lists signed by an untrusted key, tampered, rolled back or without exactly one active key', () => {
    const rogue = signed(list('cat-test-a'), keyC.secretKey);
    expect(verifyKeyList(rogue.bytes, rogue.sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'bad_signature' });
    const unknown = signed(list('cat-test-c'), keyC.secretKey);
    expect(verifyKeyList(unknown.bytes, unknown.sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'unknown_key' });
    const good = signed(list('cat-test-a'), keyA.secretKey);
    expect(verifyKeyList(flip(good.bytes, good.bytes.length - 3), good.sig, trusted, NO_SEQUENCE).ok).toBe(false);
    expect(verifyKeyList(good.bytes, good.sig, trusted, { sequence: 3, sha256: null })).toMatchObject({ ok: false, reason: 'rollback' });
    const noActive = signed(
      { ...list('cat-test-a'), keys: [{ keyId: 'cat-test-b', publicKey: toBase64(keyB.publicKey), role: 'backup' }] },
      keyA.secretKey,
    );
    expect(verifyKeyList(noActive.bytes, noActive.sig, trusted, NO_SEQUENCE)).toMatchObject({ ok: false, reason: 'schema' });
  });
});

describe('encoding and URL rules', () => {
  it('round-trips base64 and rejects invalid input', () => {
    for (const n of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37) % 256);
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
    expect(() => fromBase64('abc')).toThrow();
    expect(() => fromBase64('ab$=')).toThrow();
  });

  it('allows only HTTPS URLs without credentials, query strings or fragments', () => {
    expect(isAllowedDownloadUrl('https://download.kiwix.org/zim/a.zim')).toBe(true);
    expect(isAllowedDownloadUrl('https://127.0.0.1:8443/packs/a.zim')).toBe(true);
    expect(isAllowedDownloadUrl('http://download.kiwix.org/zim/a.zim')).toBe(false);
    expect(isAllowedDownloadUrl('https://user:pw@host/a.zim')).toBe(false);
    expect(isAllowedDownloadUrl('https://host/a.zim?x=1')).toBe(false);
    expect(isAllowedDownloadUrl('https://host/a.zim#x')).toBe(false);
  });

  it('parses the architecture example shape', () => {
    expect(parseCatalog(JSON.parse(JSON.stringify(catalog())) as unknown).packs[0]?.chunkSha256).toHaveLength(2);
  });

  it('rejects malformed pinned keys', () => {
    expect(() => pinnedKeys({ active: { keyId: 'a', publicKey: 'AAAA' }, backup: { keyId: 'b', publicKey: 'AAAA' } })).toThrow();
  });
});
