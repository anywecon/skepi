// Certificates of the local HTTPS test mirror, generated on demand and never committed (certs/README.md).
//   node e2e/mirror/gen-certs.mjs [--force]
// Creates a fresh "SKEPI Test Mirror CA" (EC P-256) in a temporary directory, signs a server certificate
// for IP:127.0.0.1 only (90 days), writes ca.crt, server.crt and server.key to e2e/mirror/certs/ and
// deletes the CA private key right after signing, so no other certificate can ever be issued under it.
// Does nothing while the three files belong together and stay valid for more than 7 days; `--force`
// regenerates. Needs the openssl CLI (on Windows: Git for Windows ships one); no npm dependency.
// After a regeneration, debug apps built before it trust the old CA: rebuild them (README.md).
import { spawnSync } from 'node:child_process';
import { X509Certificate, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// SKEPI_GEN_CERTS_TEST_DIR is for tests only (tools/release-guards/test/gen-certs.test.ts); consumers read certs/.
export const CERTS_DIR = process.env.SKEPI_GEN_CERTS_TEST_DIR ?? join(HERE, 'certs');
export const CA_CERT = join(CERTS_DIR, 'ca.crt');
export const SERVER_CERT = join(CERTS_DIR, 'server.crt');
export const SERVER_KEY = join(CERTS_DIR, 'server.key');

const DAY_MS = 86_400_000;
const VALID_DAYS = 90;
const RENEW_DAYS = 7;
// notBefore lies one day back, so a device clock that is a little behind still accepts a fresh certificate.
const BACKDATE_MS = DAY_MS;
const CA_NAME = 'SKEPI Test Mirror CA (debug builds only)';

/** Whether the certificates in certs/ can be used as they are. */
export function certsStatus(now = Date.now()) {
  if (![CA_CERT, SERVER_CERT, SERVER_KEY].every((f) => existsSync(f))) return 'missing';
  try {
    const ca = new X509Certificate(readFileSync(CA_CERT));
    const server = new X509Certificate(readFileSync(SERVER_CERT));
    const key = createPrivateKey(readFileSync(SERVER_KEY));
    if (!ca.ca || !server.verify(ca.publicKey) || !server.checkPrivateKey(key) || server.checkIP('127.0.0.1') === undefined) {
      return 'mismatched';
    }
    // Longer-lived sets were made by hand (the 10-year set once committed, whose key is in git history).
    const lifetime = Date.parse(server.validTo) - Date.parse(server.validFrom);
    if (lifetime > (VALID_DAYS + 2) * DAY_MS) return 'long-lived';
    const expires = Math.min(Date.parse(ca.validTo), Date.parse(server.validTo));
    return expires - now < RENEW_DAYS * DAY_MS ? 'expiring' : 'valid';
  } catch {
    return 'unreadable';
  }
}

function opensslVersion(bin) {
  const r = spawnSync(bin, ['version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The openssl CLI: $OPENSSL, PATH, then (Windows) the copy that Git for Windows ships. */
export function findOpenssl() {
  const candidates = [];
  if (process.env.OPENSSL) candidates.push(process.env.OPENSSL);
  candidates.push('openssl');
  if (process.platform === 'win32') {
    const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true });
    if (git.status === 0 && git.stdout.trim()) {
      // <Git>/<mingw64|ucrt64|clangarm64>/libexec/git-core
      const execPath = resolve(git.stdout.trim());
      candidates.push(join(execPath, '..', '..', 'bin', 'openssl.exe'), join(execPath, '..', '..', '..', 'usr', 'bin', 'openssl.exe'));
    }
    const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')];
    for (const root of roots.filter(Boolean)) {
      for (const sub of ['mingw64', 'ucrt64', 'clangarm64', 'usr']) candidates.push(join(root, 'Git', sub, 'bin', 'openssl.exe'));
    }
  }
  for (const bin of candidates) {
    if (bin !== 'openssl' && !existsSync(bin)) continue;
    const version = opensslVersion(bin);
    if (version) return { bin, version };
  }
  const hint =
    process.platform === 'win32'
      ? 'Install Git for Windows (it ships openssl.exe) or OpenSSL, or set OPENSSL to the path of openssl.exe.'
      : 'Install OpenSSL (package "openssl") or set OPENSSL to the path of the openssl binary.';
  throw new Error(`gen-certs: no openssl CLI found (tried ${candidates.join(', ')}). ${hint}`);
}

/** ASN.1 UTCTime as openssl ca -startdate/-enddate take it. */
function utcTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function generate(openssl, now) {
  const work = mkdtempSync(join(tmpdir(), 'skepi-mirror-certs-'));
  const caKey = join(work, 'ca.key');
  const run = (...args) => {
    const r = spawnSync(openssl, args, { cwd: work, encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`gen-certs: openssl ${args[0]} failed (exit ${r.status ?? r.error}): ${(r.stderr || '').trim()}`);
  };
  try {
    mkdirSync(join(work, 'issued'));
    writeFileSync(join(work, 'index.txt'), '');
    const serial = randomBytes(16);
    serial[0] = (serial[0] & 0x7f) | 0x01;
    writeFileSync(join(work, 'serial'), `${serial.toString('hex')}\n`);
    writeFileSync(
      join(work, 'ca.cnf'),
      [
        '[ ca ]',
        'default_ca = mirror',
        '[ mirror ]',
        // openssl runs in `work`: a relative dir keeps the temp path out of the config parser.
        'dir = .',
        'database = $dir/index.txt',
        'new_certs_dir = $dir/issued',
        'serial = $dir/serial',
        'default_md = sha256',
        'policy = policy_cn',
        'unique_subject = no',
        'copy_extensions = none',
        'email_in_dn = no',
        '[ policy_cn ]',
        'commonName = supplied',
        '[ v3_ca ]',
        'basicConstraints = critical, CA:TRUE, pathlen:0',
        'keyUsage = critical, keyCertSign, cRLSign',
        'subjectKeyIdentifier = hash',
        '[ v3_server ]',
        'basicConstraints = critical, CA:FALSE',
        'keyUsage = critical, digitalSignature',
        'extendedKeyUsage = serverAuth',
        'subjectAltName = IP:127.0.0.1',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid:always',
        '',
      ].join('\n'),
    );
    const reqConfig = (name, cn) => {
      writeFileSync(join(work, name), ['[ req ]', 'prompt = no', 'distinguished_name = dn', '[ dn ]', `CN = ${cn}`, ''].join('\n'));
      return name;
    };
    const start = utcTime(now - BACKDATE_MS);
    const end = utcTime(now + VALID_DAYS * DAY_MS);
    const keygen = (out) => run('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-pkeyopt', 'ec_param_enc:named_curve', '-out', out);

    keygen('ca.key');
    run('req', '-new', '-key', 'ca.key', '-config', reqConfig('ca-req.cnf', CA_NAME), '-out', 'ca.csr');
    run('ca', '-batch', '-selfsign', '-config', 'ca.cnf', '-keyfile', 'ca.key', '-in', 'ca.csr', '-extensions', 'v3_ca', '-startdate', start, '-enddate', end, '-notext', '-out', 'ca.crt');
    keygen('server.key');
    run('req', '-new', '-key', 'server.key', '-config', reqConfig('server-req.cnf', '127.0.0.1'), '-out', 'server.csr');
    run('ca', '-batch', '-config', 'ca.cnf', '-cert', 'ca.crt', '-keyfile', 'ca.key', '-in', 'server.csr', '-extensions', 'v3_server', '-startdate', start, '-enddate', end, '-notext', '-out', 'server.crt');
    // The CA signs exactly one certificate: its key goes before anything else happens.
    rmSync(caKey, { force: true });
    if (existsSync(caKey)) throw new Error(`gen-certs: could not delete the CA private key ${caKey}`);

    const caPem = readFileSync(join(work, 'ca.crt'));
    const serverPem = readFileSync(join(work, 'server.crt'));
    const keyPem = readFileSync(join(work, 'server.key'));
    const ca = new X509Certificate(caPem);
    const server = new X509Certificate(serverPem);
    if (!ca.ca || !server.verify(ca.publicKey) || !server.checkPrivateKey(createPrivateKey(keyPem)) || server.checkIP('127.0.0.1') === undefined) {
      throw new Error('gen-certs: the generated certificates do not belong together');
    }
    mkdirSync(CERTS_DIR, { recursive: true });
    // Same-volume temporary names, then rename: a consumer never reads half a file.
    const files = [
      [SERVER_KEY, keyPem, 0o600],
      [SERVER_CERT, serverPem, 0o644],
      [CA_CERT, caPem, 0o644],
    ];
    const suffix = `.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    for (const [file, bytes, mode] of files) writeFileSync(`${file}${suffix}`, bytes, { mode });
    for (const [file] of files) renameSync(`${file}${suffix}`, file);
    return server.validTo;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Generates the certificates when they are missing, expiring, mismatched or `force` is set. */
export function ensureCerts({ force = false, log = console.log } = {}) {
  const now = Date.now();
  const status = certsStatus(now);
  if (!force && status === 'valid') {
    const until = new X509Certificate(readFileSync(SERVER_CERT)).validTo;
    log(`gen-certs: certificates valid until ${until} (CA SHA-256 ${caSha256().slice(0, 16)})`);
    return { generated: false, status };
  }
  const openssl = findOpenssl();
  const until = generate(openssl.bin, now);
  log(`gen-certs: ${force ? 'forced' : status}: new CA and server certificate for 127.0.0.1, valid until ${until} (CA SHA-256 ${caSha256().slice(0, 16)}; ${openssl.version}). Rebuild debug apps that should reach the test mirror.`);
  return { generated: true, status };
}

/** SHA-256 (hex) of ca.crt, the bytes debug builds embed. */
export function caSha256() {
  return createHash('sha256').update(readFileSync(CA_CERT)).digest('hex');
}

// Node runs the main module from its real path: compare real paths (junctions, subst drives).
const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== '--force');
  if (unknown.length > 0) {
    console.error(`usage: node e2e/mirror/gen-certs.mjs [--force] (unknown: ${unknown.join(' ')})`);
    process.exit(2);
  }
  try {
    ensureCerts({ force: args.includes('--force') });
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
