// Committed text snapshots of the public-domain web sources (snapshots/<source id>.txt): a header with
// the URL, the retrieval date and the SHA-256 of the fetched HTML, then the page text (html.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractHtmlText } from './html';
import { sha256 } from './source';

export const SNAPSHOT_DIR = fileURLToPath(new URL('../snapshots/', import.meta.url));
const SEPARATOR = '---\n';

export interface Snapshot {
  url: string;
  retrieved: string;
  htmlSha256: string;
  /** The page text (html.ts), one block per line. */
  text: string;
}

export function snapshotPath(id: string): string {
  return `${SNAPSHOT_DIR}${id}.txt`;
}

export function formatSnapshot(s: Snapshot): string {
  return [
    `url: ${s.url}`,
    `retrieved: ${s.retrieved}`,
    `html-sha256: ${s.htmlSha256}`,
    'extractor: tools/cards-source-check/src/html.ts (the <main> element, one block per line)',
    SEPARATOR,
  ].join('\n') + s.text;
}

export function parseSnapshot(content: string): Snapshot {
  const split = content.indexOf(`\n${SEPARATOR}`);
  if (split < 0) throw new Error('snapshot without a "---" header separator');
  const header = new Map<string, string>();
  for (const line of content.slice(0, split).split('\n')) {
    const colon = line.indexOf(': ');
    if (colon > 0) header.set(line.slice(0, colon), line.slice(colon + 2));
  }
  const field = (name: string): string => {
    const v = header.get(name);
    if (!v) throw new Error(`snapshot header without "${name}"`);
    return v;
  };
  return { url: field('url'), retrieved: field('retrieved'), htmlSha256: field('html-sha256'), text: content.slice(split + 1 + SEPARATOR.length) };
}

export function readSnapshot(id: string): Snapshot {
  return parseSnapshot(readFileSync(snapshotPath(id), 'utf8').replace(/\r\n/gu, '\n'));
}

/** SHA-256 of the snapshot text (what WebSource.textSha256 pins). */
export function textSha256(text: string): string {
  return sha256(Buffer.from(text, 'utf8'));
}

/** Downloads the page now (the HTML bytes). Node's fetch (some CDNs refuse curl). */
export async function downloadPage(url: string): Promise<Uint8Array> {
  // cdc.gov (Akamai) answers 403 to GitHub runners for a request without the usual language and
  // encoding headers (drift run 39671621980); with them it serves the page (probe run 39752883835).
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'SKEPI cards-source-check (+https://github.com/anywecon/skepi)',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)} ${url}`);
  if (response.url !== url) throw new Error(`${url} redirected to ${response.url}: pin the new URL deliberately`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The page text of downloaded HTML, as a snapshot holds it. */
export function pageText(bytes: Uint8Array): string {
  return extractHtmlText(Buffer.from(bytes).toString('utf8'));
}

/** Fetches the page now: its HTML hash and extracted text. */
export async function fetchPage(url: string): Promise<{ htmlSha256: string; text: string }> {
  const bytes = await downloadPage(url);
  return { htmlSha256: sha256(bytes), text: pageText(bytes) };
}
