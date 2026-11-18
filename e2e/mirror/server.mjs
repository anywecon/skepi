// Local HTTPS test mirror for the download E2E (debug build org.skepi.app.dev, adb reverse tcp:8443).
//   https://127.0.0.1:8443/packs/<file>     fixture packs (HTTP Range supported)
//   https://127.0.0.1:8443/corrupt/<file>   same size, one byte flipped every 4 KiB (hash mismatch)
//   https://127.0.0.1:8443/catalog/<name>   catalog.json + .sig of the current mode (e2e/mirror/catalogs/<mode>/;
//                                           mode "countries": e2e/out/countries-catalog/, made by e2e/run-countries-e2e.ps1)
//   https://127.0.0.1:8443/maps/<file>      country map and places packs from the builder cache (MIRROR_MAPS_DIR,
//                                           only files the countries catalog names; streamed, HTTP Range)
// Admin (host only, never reversed to the phone): http://127.0.0.1:8444/mode/<mode>, /log, /reset.
// Every request is logged (method, path, query, range, user-agent) to e2e/out/mirror-log.jsonl.
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVER_CERT, SERVER_KEY, ensureCerts } from './gen-certs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const FIXTURES = join(REPO, 'tools', 'rag-eval', 'fixtures');
const OUT = join(REPO, 'e2e', 'out');
const LOG = join(OUT, 'mirror-log.jsonl');
const PACKS = new Set(['eval-smoke-en.zim', 'eval-smoke-el.zim', 'eval-synthetic.zim', 'eval-heldout.zim', 'p2p-propagation.zim']);
const MODES = new Set(['good', 'tampered', 'wrong-key', 'rollback', 'countries']);
const COUNTRIES_CATALOG = join(OUT, 'countries-catalog');
const MAPS_DIR = process.env.MIRROR_MAPS_DIR ?? null;
const PORT = Number(process.env.MIRROR_PORT ?? 8443);
const ADMIN_PORT = Number(process.env.MIRROR_ADMIN_PORT ?? 8444);
const RANGE = /^bytes=(\d+)-(\d*)$/;

mkdirSync(OUT, { recursive: true });
let mode = 'good';
const requests = [];

function corrupt(bytes) {
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i += 4096) out[i] ^= 0xff;
  return out;
}

function send(req, res, body, type) {
  const size = body.length;
  const header = req.headers.range ?? '';
  const range = RANGE.test(header) ? header.slice(6).split('-') : null;
  if (range) {
    const start = Number(range[0]);
    const end = range[1] ? Math.min(Number(range[1]), size - 1) : size - 1;
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return 416;
    }
    res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes' });
    res.end(req.method === 'HEAD' ? undefined : body.subarray(start, end + 1));
    return 206;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  res.end(req.method === 'HEAD' ? undefined : body);
  return 200;
}

/** Files of the countries catalog (the only names served from MIRROR_MAPS_DIR). */
function countryFiles() {
  const file = join(COUNTRIES_CATALOG, 'catalog.json');
  if (!existsSync(file)) return new Set();
  return new Set(JSON.parse(readFileSync(file, 'utf8')).packs.map((p) => p.file));
}

/** Large packs are streamed from disk (never read whole into memory), with HTTP Range. */
function sendFile(req, res, path) {
  const size = statSync(path).size;
  const header = req.headers.range ?? '';
  const range = RANGE.test(header) ? header.slice(6).split('-') : null;
  let start = 0;
  let end = size - 1;
  let status = 200;
  if (range) {
    start = Number(range[0]);
    end = range[1] ? Math.min(Number(range[1]), size - 1) : size - 1;
    if (start >= size) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      res.end();
      return 416;
    }
    status = 206;
  }
  res.writeHead(status, {
    'content-type': 'application/octet-stream',
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    ...(status === 206 ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(path, { start, end }).pipe(res);
  return status;
}

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'https://127.0.0.1');
  const [, area, name] = url.pathname.split('/');
  let status = 404;
  try {
    if (area === 'maps' && MAPS_DIR && countryFiles().has(name)) {
      status = sendFile(req, res, join(MAPS_DIR, name));
    } else if ((area === 'packs' || area === 'corrupt') && PACKS.has(name)) {
      const bytes = readFileSync(name === 'p2p-propagation.zim' ? join(REPO, 'e2e', 'fixtures', name) : join(FIXTURES, name));
      status = send(req, res, area === 'corrupt' ? corrupt(bytes) : bytes, 'application/octet-stream');
    } else if (area === 'catalog' && (name === 'catalog.json' || name === 'catalog.json.sig')) {
      const file = mode === 'countries' ? join(COUNTRIES_CATALOG, name) : join(HERE, 'catalogs', mode, name);
      statSync(file);
      status = send(req, res, readFileSync(file), name.endsWith('.sig') ? 'text/plain' : 'application/json');
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch {
    res.writeHead(404);
    res.end();
  }
  const entry = {
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    query: url.search,
    range: req.headers.range ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    status,
    mode,
  };
  requests.push(entry);
  appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
}

// Certificates are generated on demand (gen-certs.mjs), never committed.
ensureCerts();
const tls = { key: readFileSync(SERVER_KEY), cert: readFileSync(SERVER_CERT) };
createServer(tls, handle).listen(PORT, '127.0.0.1', () => {
  console.log(`test mirror on https://127.0.0.1:${PORT} (mode ${mode})`);
});

createHttp((req, res) => {
  const [, cmd, arg] = (req.url ?? '/').split('/');
  if (cmd === 'mode' && MODES.has(arg)) {
    mode = arg;
    res.end(JSON.stringify({ mode }));
  } else if (cmd === 'log') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(requests));
  } else if (cmd === 'reset') {
    requests.length = 0;
    mode = 'good';
    res.end('{}');
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(ADMIN_PORT, '127.0.0.1');
