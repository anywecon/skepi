import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIVATE_KEY_ALLOWLIST, findPrivateKeys, privateKeyReason, trackedFiles } from '../src/private-keys';

// Built from parts so this test file holds no PEM marker of its own.
const BEGIN = '-----BEGIN ';
const pem = (label: string) => Buffer.from(`${BEGIN}${label}-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg\n-----END ${label}-----\n`);
const text = (s: string) => Buffer.from(s);

describe('private key guard', () => {
  it('refuses key and keystore formats by name', () => {
    for (const name of ['certs/server.key', 'a/release.jks', 'b/upload.KEYSTORE', 'c/id.p12', 'd/cert.pfx']) {
      expect(privateKeyReason(name, text('')), name).toMatch(/key or keystore file name/);
    }
  });

  it('finds PEM private key blocks in any file, whatever the name', () => {
    for (const label of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY', 'PGP PRIVATE KEY BLOCK']) {
      expect(privateKeyReason('docs/notes.md', pem(label)), label).toMatch(/contains a PEM private key block/);
    }
    expect(privateKeyReason('certs/key.pem', pem('PRIVATE KEY'))).toMatch(/PEM file with a private key/);
    // Inside a binary file too.
    expect(privateKeyReason('assets/blob.bin', Buffer.concat([Buffer.from([0, 255, 7]), pem('PRIVATE KEY'), Buffer.from([0])]))).not.toBeNull();
  });

  it('lets certificates, public keys and mentions pass', () => {
    expect(privateKeyReason('certs/ca.pem', text(`${BEGIN}CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n`))).toBeNull();
    expect(privateKeyReason('keys/pub.pem', text(`${BEGIN}PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----\n`))).toBeNull();
    expect(privateKeyReason('docs/a.md', text('a private key never goes in the repository'))).toBeNull();
    expect(privateKeyReason('catalog/keys/test.json', text('{"keyId":"cat-test-2026a"}'))).toBeNull();
    expect(privateKeyReason('src/keyboard.ts', text(''))).toBeNull();
  });

  it('honours an explicit allowlist, which is empty', () => {
    const files = [
      { path: 'a/server.key', content: text('') },
      { path: 'b/notes.txt', content: pem('PRIVATE KEY') },
    ];
    expect(findPrivateKeys(files).map((f) => f.path)).toEqual(['a/server.key', 'b/notes.txt']);
    expect(findPrivateKeys(files, ['a/server.key']).map((f) => f.path)).toEqual(['b/notes.txt']);
    expect(PRIVATE_KEY_ALLOWLIST).toEqual([]);
  });

  it('finds no private key in this repository', { timeout: 60_000 }, () => {
    const repo = fileURLToPath(new URL('../../..', import.meta.url));
    expect(findPrivateKeys(trackedFiles(repo))).toEqual([]);
  });

  describe('tracked files of a repository', () => {
    const roots: string[] = [];
    afterEach(() => {
      for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    });
    const git = (cwd: string, ...args: string[]) => {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };

    it('checks only what git tracks, including keys that .gitignore would hide', { timeout: 30_000 }, () => {
      const root = mkdtempSync(join(tmpdir(), 'skepi-private-keys-'));
      roots.push(root);
      git(root, 'init', '-q');
      mkdirSync(join(root, 'certs'));
      writeFileSync(join(root, '.gitignore'), '*.key\n');
      writeFileSync(join(root, 'certs', 'local.key'), pem('PRIVATE KEY'));
      writeFileSync(join(root, 'certs', 'forced.key'), pem('EC PRIVATE KEY'));
      writeFileSync(join(root, 'readme.md'), 'no keys here\n');
      git(root, 'add', '.gitignore', 'readme.md');
      git(root, 'add', '-f', 'certs/forced.key');
      const findings = findPrivateKeys(trackedFiles(root));
      expect(findings.map((f) => f.path)).toEqual(['certs/forced.key']);
    });
  });
});
