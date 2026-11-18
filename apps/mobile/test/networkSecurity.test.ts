import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

type WriteNetworkSecurityFiles = (appDir: string, testCa?: string) => void;
const require = createRequire(import.meta.url);
const plugin = require('../plugins/withContentStore.js') as { writeNetworkSecurityFiles: WriteNetworkSecurityFiles };

const CA = '-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n';

describe('network security config (plugins/withContentStore.js)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const sandbox = () => {
    const d = mkdtempSync(join(tmpdir(), 'skepi-nsc-'));
    dirs.push(d);
    return d;
  };
  const read = (appDir: string, rel: string) => readFileSync(join(appDir, rel), 'utf8');
  const debugXml = 'debug/res/xml/network_security_config.xml';
  const debugCa = 'debug/res/raw/skepi_test_mirror_ca.pem';
  const mainXml = 'main/res/xml/network_security_config.xml';

  it('trusts the test mirror CA in debug builds only, and only for 127.0.0.1', () => {
    const root = sandbox();
    const ca = join(root, 'ca.crt');
    writeFileSync(ca, CA);
    const appDir = join(root, 'src');
    plugin.writeNetworkSecurityFiles(appDir, ca);
    expect(read(appDir, debugCa)).toBe(CA);
    const debug = read(appDir, debugXml);
    expect(debug).toContain('<domain includeSubdomains="false">127.0.0.1</domain>');
    expect(debug).toContain('<certificates src="@raw/skepi_test_mirror_ca" />');
    const main = read(appDir, mainXml);
    expect(main).not.toContain('skepi_test_mirror_ca');
    expect(main).toContain('<certificates src="system" />');
  });

  it('without ca.crt: no test mirror entry, a stale CA copy is removed, release config unchanged', () => {
    const root = sandbox();
    const ca = join(root, 'ca.crt');
    writeFileSync(ca, CA);
    const appDir = join(root, 'src');
    plugin.writeNetworkSecurityFiles(appDir, ca);
    const mainBefore = read(appDir, mainXml);
    rmSync(ca);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    plugin.writeNetworkSecurityFiles(appDir, ca);
    expect(existsSync(join(appDir, debugCa))).toBe(false);
    const debug = read(appDir, debugXml);
    expect(debug).not.toContain('127.0.0.1');
    expect(debug).not.toContain('skepi_test_mirror_ca');
    expect(debug).toContain('<domain includeSubdomains="false">localhost</domain>');
    expect(read(appDir, mainXml)).toBe(mainBefore);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/ca\.crt not found/);
  });
});
