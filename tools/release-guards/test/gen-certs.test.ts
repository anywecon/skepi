import { X509Certificate, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// e2e/mirror/gen-certs.mjs (the local test mirror's certificates), run as the E2E scripts run it.
const SCRIPT = fileURLToPath(new URL('../../../e2e/mirror/gen-certs.mjs', import.meta.url));
const DAY = 86_400_000;

describe('test mirror certificates (e2e/mirror/gen-certs.mjs)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (dir: string, ...args: string[]) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, SKEPI_GEN_CERTS_TEST_DIR: dir } });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout;
  };
  const files = (dir: string) => ({
    ca: new X509Certificate(readFileSync(join(dir, 'ca.crt'))),
    server: new X509Certificate(readFileSync(join(dir, 'server.crt'))),
    key: readFileSync(join(dir, 'server.key')),
  });

  it('makes a CA and one 127.0.0.1-only server certificate, short-lived, and keeps nothing else', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'skepi-gen-certs-'));
    dirs.push(dir);
    expect(run(dir)).toMatch(/gen-certs: missing: new CA/);
    expect(readdirSync(dir).sort()).toEqual(['ca.crt', 'server.crt', 'server.key']);
    const { ca, server, key } = files(dir);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain('SKEPI Test Mirror CA');
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(server.ca).toBe(false);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkPrivateKey(createPrivateKey(key))).toBe(true);
    expect(server.subjectAltName).toBe('IP Address:127.0.0.1');
    expect(server.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(server.checkHost('localhost')).toBeUndefined();
    const lifetime = Date.parse(server.validTo) - Date.parse(server.validFrom);
    expect(lifetime).toBeLessThanOrEqual(92 * DAY);
    expect(Date.parse(server.validFrom)).toBeLessThan(Date.now());
  });

  it('keeps a valid set, regenerates on --force and when the set is broken', { timeout: 120_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'skepi-gen-certs-'));
    dirs.push(dir);
    run(dir);
    const first = readFileSync(join(dir, 'ca.crt'), 'utf8');
    expect(run(dir)).toMatch(/certificates valid until/);
    expect(readFileSync(join(dir, 'ca.crt'), 'utf8')).toBe(first);
    expect(run(dir, '--force')).toMatch(/forced: new CA/);
    const second = readFileSync(join(dir, 'ca.crt'), 'utf8');
    expect(second).not.toBe(first);
    // A server certificate from another generation no longer verifies against ca.crt.
    writeFileSync(join(dir, 'ca.crt'), first);
    expect(run(dir)).toMatch(/mismatched: new CA/);
    rmSync(join(dir, 'server.key'));
    expect(run(dir)).toMatch(/missing: new CA/);
    expect(existsSync(join(dir, 'server.key'))).toBe(true);
  });

  it('refuses unknown arguments', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8', env: { ...process.env, SKEPI_GEN_CERTS_TEST_DIR: join(tmpdir(), 'unused') } });
    expect(r.status).toBe(2);
  });
});
