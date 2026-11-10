import { parseCatalog, pinnedKeys, trustedFromPinned, type PinnedKeyInput } from '@skepi/core';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCatalog, prepareCatalog, sequenceOf, sha256Hex, signKeyList, signPreparedCatalog, verifyCatalogDir, verifyKeyListDir, writeSigned } from './build';
import { countryManifest, readCountrySources, readRegionIndex, selectParts } from './countries';
import { keygen, readPinnedKeys, readSecretKey, REPO_ROOT, type PinnedKeysFile } from './keys';
import { checkFixtures } from './fixtures';
import { pmtilesCli } from './mapExtract';
import { mergeManifests, readManifest } from './manifest';
import { buildPackReport, compareWithReport, type PackReport } from './pack';
import { defaultCacheDir, legacySkepiDir, migrateDir, resolveCacheDir, skepiHome } from './paths';

/**
 * SKEPI catalog-builder (dev machine only; the signing key never enters CI).
 *
 *   keygen  --key-id <id> --out <file outside the repo>
 *   pin     --active <id.pub.json> --backup <id.pub.json> --purpose release|test --out catalog/keys/<purpose>.json
 *   build   --manifest catalog/manifest.json [--manifest more.json] --key <secret file> --out <dir> [--cache <dir>] [--sequence N] [--previous <catalog.json>] [--revoked <file>]
 *           --revoked (also for prepare): a text file, one SHA-256 per line (# comments), of pack files the catalog revokes
 *   keylist --pinned <new keys json> --key <secret of the replaced key> --sequence N --out <dir>
 *   verify  --dir <dir> --pinned catalog/keys/<purpose>.json [--release]
 *   migrate-cache [--cache <dir>]   moves %TEMP%\skepi\{cache,keys} to %LOCALAPPDATA%\skepi (SHA-256 checked)
 *   countries --iso GR,CY,… | --pilot | --all [--out catalog/countries.json] [--mirror https://…/] [--parts JP:kanto,…]   country map + places manifest entries (--parts: only these parts of those split countries)
 *   pack    --manifest <m.json> --id <pack id> --out <dir> [--cache <dir>]   builds one pack, writes <id>.report.json (CI)
 *   prepare … --reports <dir>   also requires every pack to match its CI report (size, SHA-256, chunks)
 */
const USAGE = 'usage: catalog <keygen|pin|build|prepare|sign|keylist|verify|migrate-cache|check-fixtures|countries|pack> [options] (see src/cli.ts)';

/** One SHA-256 per line; blank lines and # comments are ignored (parseCatalog checks the hashes). */
function readRevoked(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * The previous catalog's revocations and the new ones: a revocation is never dropped by a later catalog
 * (a device that skipped the revoking catalog still gets it).
 */
function revokedWith(previousCatalog: string, file: string | undefined): string[] {
  const previous = existsSync(previousCatalog) ? (parseCatalog(JSON.parse(readFileSync(previousCatalog, 'utf8')) as unknown).revoked ?? []) : [];
  return [...new Set([...previous, ...(file ? readRevoked(resolve(file)) : []).map((h) => h.toLowerCase())])];
}

const [command, ...rest] = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
const { values: args } = parseArgs({
  args: rest,
  options: {
    'key-id': { type: 'string' },
    out: { type: 'string' },
    active: { type: 'string' },
    backup: { type: 'string' },
    purpose: { type: 'string' },
    manifest: { type: 'string', multiple: true },
    revoked: { type: 'string' },
    key: { type: 'string' },
    cache: { type: 'string' },
    sequence: { type: 'string' },
    previous: { type: 'string' },
    'issued-at': { type: 'string' },
    pinned: { type: 'string' },
    dir: { type: 'string' },
    release: { type: 'boolean', default: false },
    'expect-sha256': { type: 'string' },
    iso: { type: 'string' },
    pilot: { type: 'boolean', default: false },
    all: { type: 'boolean', default: false },
    id: { type: 'string' },
    reports: { type: 'string' },
    mirror: { type: 'string' },
    parts: { type: 'string' },
  },
});

function readReports(dir: string): Map<string, PackReport> {
  const out = new Map<string, PackReport>();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.report.json'))) {
    const report = JSON.parse(readFileSync(join(dir, name), 'utf8')) as PackReport;
    out.set(report.pack.id, report);
  }
  return out;
}

function need(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required\n${USAGE}`);
  return value;
}

function cacheDir(): string {
  return resolveCacheDir(args.cache);
}

function readPublic(path: string): PinnedKeyInput {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Partial<PinnedKeyInput>;
  if (typeof data.keyId !== 'string' || typeof data.publicKey !== 'string') throw new Error(`${path}: expected { keyId, publicKey }`);
  return { keyId: data.keyId, publicKey: data.publicKey };
}

async function main(): Promise<number> {
  switch (command) {
    case 'keygen': {
      const out = resolve(need('out', args.out));
      const pub = keygen(need('key-id', args['key-id']), out);
      const pubPath = `${out}.pub.json`;
      writeFileSync(pubPath, `${JSON.stringify(pub, null, 2)}\n`, { flag: 'wx' });
      console.log(`secret key written to ${out} (keep it offline, never commit it, never put it in CI)`);
      console.log(`public key written to ${pubPath}:\n${JSON.stringify(pub, null, 2)}`);
      return 0;
    }
    case 'pin': {
      const purpose = need('purpose', args.purpose);
      if (purpose !== 'release' && purpose !== 'test') throw new Error('--purpose must be release or test');
      const file: PinnedKeysFile = { schema: 1, purpose, active: readPublic(need('active', args.active)), backup: readPublic(need('backup', args.backup)) };
      pinnedKeys(file);
      if (file.active.keyId === file.backup.keyId || file.active.publicKey === file.backup.publicKey) throw new Error('active and backup keys must differ');
      writeFileSync(need('out', args.out), `${JSON.stringify(file, null, 2)}\n`);
      console.log(`pinned ${purpose} keys: active ${file.active.keyId}, backup ${file.backup.keyId}`);
      return 0;
    }
    case 'build': {
      const out = resolve(need('out', args.out));
      const key = readSecretKey(need('key', args.key));
      const previousPath = args.previous ?? join(out, 'catalog.json');
      const built = await buildCatalog({
        manifest: mergeManifests((args.manifest ?? []).map(readManifest)),
        cacheDir: cacheDir(),
        key,
        previousSequence: sequenceOf(previousPath),
        ...(args.sequence ? { sequence: Number(args.sequence) } : {}),
        revoked: revokedWith(previousPath, args.revoked),
        ...(args['issued-at'] ? { issuedAt: args['issued-at'] } : {}),
        log: (line) => {
          console.log(line);
        },
      });
      await writeSigned(out, 'catalog.json', built);
      console.log(`catalog sequence ${String(built.catalog.sequence)} with ${String(built.catalog.packs.length)} packs signed by ${key.keyId} -> ${out}`);
      return 0;
    }
    case 'keylist': {
      const signer = readSecretKey(need('key', args.key));
      const next = readPinnedKeys(need('pinned', args.pinned));
      const signed = signKeyList(
        {
          sequence: Number(need('sequence', args.sequence)),
          issuedAt: args['issued-at'] ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          keys: [
            { ...next.active, role: 'active' },
            { ...next.backup, role: 'backup' },
          ],
        },
        signer,
      );
      await writeSigned(resolve(need('out', args.out)), 'keys.json', signed);
      console.log(`key list signed by ${signer.keyId}: active ${next.active.keyId}, backup ${next.backup.keyId}`);
      return 0;
    }
    case 'prepare': {
      // Measures the packs and writes the exact catalog.json bytes for --key-id to sign later on the
      // offline machine (`sign`); no key is read. --previous is required: the sequence must increase.
      const out = resolve(need('out', args.out));
      const previous = resolve(need('previous', args.previous));
      const prepared = await prepareCatalog({
        manifest: mergeManifests((args.manifest ?? []).map(readManifest)),
        cacheDir: cacheDir(),
        keyId: need('key-id', args['key-id']),
        previousSequence: sequenceOf(previous),
        ...(args.sequence ? { sequence: Number(args.sequence) } : {}),
        revoked: revokedWith(previous, args.revoked),
        ...(args['issued-at'] ? { issuedAt: args['issued-at'] } : {}),
        log: (line) => {
          console.log(line);
        },
      });
      if (args.reports) {
        // Packs built in CI (packs.yml) and measured again here must be the same bytes.
        const reports = readReports(resolve(args.reports));
        const problems = prepared.catalog.packs.flatMap((p) => {
          const report = reports.get(p.id);
          if (!report) return p.kind === 'pmtiles' || p.kind === 'places' ? [`${p.id}: no CI report`] : [];
          return compareWithReport(p, report).map((m) => `${p.id}: ${m}`);
        });
        if (problems.length > 0) throw new Error(`packs differ from their CI reports:\n${problems.join('\n')}`);
        console.log(`every map and places pack matches its CI report (${String(reports.size)} reports)`);
      }
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'catalog.json'), prepared.bytes);
      rmSync(join(out, 'catalog.json.sig'), { force: true });
      console.log(
        `prepared catalog sequence ${String(prepared.catalog.sequence)} (${String(prepared.catalog.packs.length)} packs) for ${prepared.catalog.keyId} -> ${join(out, 'catalog.json')}`,
      );
      console.log(`SHA-256 of the bytes to sign: ${sha256Hex(prepared.bytes)}`);
      return 0;
    }
    case 'sign': {
      // Signs <dir>/catalog.json exactly as prepared (writes <dir>/catalog.json.sig); refuses other keys,
      // a non-increasing sequence, non-canonical bytes and, with --expect-sha256, any other bytes.
      const dir = resolve(need('dir', args.dir));
      const key = readSecretKey(need('key', args.key));
      const signed = signPreparedCatalog(new Uint8Array(readFileSync(join(dir, 'catalog.json'))), key, {
        previousSequence: sequenceOf(resolve(need('previous', args.previous))),
        ...(args['expect-sha256'] ? { expectSha256: args['expect-sha256'] } : {}),
      });
      writeFileSync(join(dir, 'catalog.json.sig'), `${signed.signature}\n`, 'utf8');
      console.log(`signed catalog sequence ${String(signed.catalog.sequence)} (SHA-256 ${signed.sha256}) with ${key.keyId} -> ${join(dir, 'catalog.json.sig')}`);
      return 0;
    }
    case 'countries': {
      const pinned = readCountrySources();
      // --mirror: the same packs from another mirror (the E2E's local test mirror, https://127.0.0.1:8443/maps/).
      const sources = args.mirror ? { ...pinned, mirror: args.mirror } : pinned;
      const index = readRegionIndex();
      const iso = args.all
        ? index.regions.map((r) => r.iso2)
        : args.pilot
          ? sources.pilot
          : need('iso', args.iso).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const all = countryManifest(index, sources, iso);
      const manifest = args.parts ? selectParts(all, args.parts.split(',').map((s) => s.trim()).filter(Boolean)) : all;
      const out = resolve(args.out ?? join(REPO_ROOT, 'catalog', 'countries.json'));
      writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`${String(manifest.packs.length)} packs of ${String(iso.length)} countries -> ${out}`);
      return 0;
    }
    case 'pack': {
      const id = need('id', args.id);
      const manifest = mergeManifests((args.manifest ?? []).map(readManifest));
      const pack = manifest.packs.find((p) => p.id === id);
      if (!pack) throw new Error(`${id}: not in the manifest(s)`);
      const cache = cacheDir();
      const log = (line: string): void => {
        console.log(line);
      };
      const pmtiles = pack.source.kind === 'pmtiles-extract' ? await pmtilesCli(cache, log) : null;
      const report = await buildPackReport(pack, { manifest, cacheDir: cache, log, pmtiles });
      const out = resolve(need('out', args.out));
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `${id}.report.json`), `${JSON.stringify(report, null, 2)}\n`);
      console.log(`${id}: ${String(report.pack.sizeBytes)} bytes, sha256 ${report.pack.sha256}, ${String(report.seconds)} s -> ${join(out, `${id}.report.json`)}`);
      return 0;
    }
    case 'check-fixtures': {
      // Every file the test catalogs, manifests and tests use is committed (CI: verify job).
      const problems = checkFixtures(REPO_ROOT);
      for (const p of problems) console.error(`${p.from}: ${p.file}: ${p.problem}`);
      console.log(problems.length === 0 ? 'FIXTURES OK: every referenced test file is committed' : `FIXTURES FAIL: ${String(problems.length)} problems`);
      return problems.length === 0 ? 0 : 1;
    }
    case 'migrate-cache': {
      const legacy = legacySkepiDir();
      const targets = [
        { from: join(legacy, 'cache'), to: args.cache ?? defaultCacheDir() },
        // Test signing keys (never release keys) were kept beside the cache in Phase 1c-2a.
        { from: join(legacy, 'keys'), to: join(skepiHome(), 'keys') },
      ];
      for (const { from, to } of targets) {
        const moved = await migrateDir(from, to, (line) => {
          console.log(line);
        });
        const conflicts = moved.filter((m) => m.result === 'conflict').length;
        const bytes = moved.reduce((sum, m) => sum + m.sizeBytes, 0);
        console.log(`${from} -> ${to}: ${String(moved.length - conflicts)} files (${String(bytes)} bytes) verified by SHA-256, ${String(conflicts)} conflicts`);
        if (conflicts > 0) return 1;
      }
      return 0;
    }
    case 'verify': {
      const dir = resolve(need('dir', args.dir));
      const pinnedFile = readPinnedKeys(need('pinned', args.pinned));
      const trusted = trustedFromPinned(pinnedKeys(pinnedFile));
      if (args.release) {
        // A release build must embed a catalog signed with the real key: never the test key.
        if (pinnedFile.purpose !== 'release') throw new Error('release builds must pin purpose "release" keys');
        const testKeys = join(REPO_ROOT, 'catalog', 'keys', 'test.json');
        if (existsSync(testKeys)) {
          const test = readPinnedKeys(testKeys);
          const testPublic = new Set([test.active.publicKey, test.backup.publicKey]);
          if (testPublic.has(pinnedFile.active.publicKey) || testPublic.has(pinnedFile.backup.publicKey)) {
            throw new Error('release keys must not be the test keys');
          }
        }
      }
      const r = verifyCatalogDir(dir, trusted);
      if (!r.ok) {
        console.error(`CATALOG REJECTED (${r.reason}): ${r.detail}`);
        return 1;
      }
      if (existsSync(join(dir, 'keys.json'))) {
        const k = verifyKeyListDir(dir, trusted);
        if (!k.ok) {
          console.error(`KEY LIST REJECTED (${k.reason}): ${k.detail}`);
          return 1;
        }
      }
      console.log(`catalog OK: sequence ${String(r.sequence)}, ${String(r.value.packs.length)} packs, key ${r.value.keyId}, sha256 ${r.sha256}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 2;
  },
);
