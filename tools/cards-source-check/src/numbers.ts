// Emergency numbers (packages/emergency-cards/src/numbers.ts), checked like the card sources: every
// checked source has a committed text snapshot (snapshots/numbers/<id>.txt: URL, retrieval date, SHA-256
// of the fetched HTML or PDF, for a PDF the pdftotext version, then its text), pinned by the dataset (file
// and text hash), and every number of a country must stand in a verbatim quote of one of its checked sources.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTRY_NUMBERS, UNCHECKED_NUMBER_COUNTRIES, type CountryNumbers, type NumberCheck, type NumberSource } from '@skepi/emergency-cards';
import { includesExcerpt, normalizePage, normalizeStep } from './check';
import { extractHtmlText } from './html';
import { extractText, pdftotextBinary, sha256 } from './source';
import { textSha256 } from './snapshot';

export const NUMBERS_DIR = fileURLToPath(new URL('../snapshots/numbers/', import.meta.url));
const SEPARATOR = '---\n';

export interface NumberSnapshot {
  url: string;
  retrieved: string;
  format: NumberCheck['format'];
  fileSha256: string;
  /** PDF only: the `pdftotext -v` line of the extractor that wrote the text (null for HTML: html.ts). */
  extractorVersion: string | null;
  text: string;
}

export function numberSnapshotPath(id: string): string {
  return `${NUMBERS_DIR}${id}.txt`;
}

export function formatNumberSnapshot(s: NumberSnapshot): string {
  const extractor =
    s.format === 'pdf'
      ? 'pdftotext -enc UTF-8, lines trimmed, blank lines dropped (tools/cards-source-check/src/numbers.ts)'
      : 'tools/cards-source-check/src/html.ts (the <main> element, one block per line)';
  const version = s.format === 'pdf' ? [`extractor-version: ${s.extractorVersion ?? ''}`] : [];
  return [`url: ${s.url}`, `retrieved: ${s.retrieved}`, `format: ${s.format}`, `file-sha256: ${s.fileSha256}`, `extractor: ${extractor}`, ...version, SEPARATOR].join('\n') + s.text;
}

export function parseNumberSnapshot(content: string): NumberSnapshot {
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
  const format = field('format');
  if (format !== 'html' && format !== 'pdf') throw new Error(`snapshot format ${format}`);
  return {
    url: field('url'),
    retrieved: field('retrieved'),
    format,
    fileSha256: field('file-sha256'),
    extractorVersion: format === 'pdf' ? field('extractor-version') : null,
    text: content.slice(split + 1 + SEPARATOR.length),
  };
}

export function readNumberSnapshot(id: string): NumberSnapshot {
  return parseNumberSnapshot(readFileSync(numberSnapshotPath(id), 'utf8').replace(/\r\n/gu, '\n'));
}

/** PDF text as committed: one line per text line, trimmed, blank lines and page breaks dropped. */
export function pdfLines(text: string): string {
  const lines = text
    .split(/[\n\f]/u)
    .map((l) => l.replace(/[\s\u200b\ufeff]+/gu, ' ').trim())
    .filter((l) => l.length > 0);
  return `${lines.join('\n')}\n`;
}

/** Downloads a source now (the HTML or PDF bytes). Node's fetch, as for the card sources. */
export async function downloadNumberSource(url: string, format: NumberCheck['format']): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'SKEPI cards-source-check (+https://github.com/anywecon/skepi)',
      Accept: format === 'pdf' ? 'application/pdf' : 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)} ${url}`);
  if (response.url !== url) throw new Error(`${url} redirected to ${response.url}: pin the new URL deliberately`);
  return new Uint8Array(await response.arrayBuffer());
}

/** The text of a downloaded source as a snapshot holds it (html.ts, or pdftotext and pdfLines). */
export function numberSourceText(bytes: Uint8Array, format: NumberCheck['format'], bin: string = pdftotextBinary()): string {
  if (format === 'html') return extractHtmlText(Buffer.from(bytes).toString('utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'skepi-numbers-'));
  try {
    const pdf = join(dir, 'source.pdf');
    writeFileSync(pdf, bytes);
    return pdfLines(extractText(pdf, bin));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fetches a source now: the file's hash and its text. */
export async function fetchNumberSource(url: string, format: NumberCheck['format']): Promise<{ fileSha256: string; text: string }> {
  const bytes = await downloadNumberSource(url, format);
  return { fileSha256: sha256(bytes), text: numberSourceText(bytes, format) };
}

/**
 * PDF text depends on the pdftotext build (Xpdf and Poppler, or two Poppler versions, break lines
 * differently), so a PDF snapshot is only comparable with text from the version that wrote it: one
 * problem per PDF snapshot written by another version than `current`.
 */
export function extractorProblems(snapshots: ReadonlyMap<string, NumberSnapshot>, current: string): string[] {
  const out: string[] = [];
  for (const [id, s] of snapshots) {
    if (s.format === 'pdf' && s.extractorVersion !== current) out.push(`${id}: snapshot extracted with "${s.extractorVersion ?? 'unknown'}", this pdftotext is "${current}"`);
  }
  return out;
}

/** The digits of a text ("(800) 222-1222" → "8002221222"). */
function digitsOf(text: string): string {
  return text.replace(/\D/gu, '');
}

/**
 * Whether a quote shows a number: its digits in the quote's digits; a North American number of the
 * dataset (1 + 10 digits) may be written without the leading 1 ("(800) 222-1222").
 */
export function quoteShows(quote: string, number: string): boolean {
  const digits = digitsOf(quote);
  return digits.includes(number) || (number.length === 11 && number.startsWith('1') && digits.includes(number.slice(1)));
}

/** Every number of a country entry: the general one and each service. */
export function numbersOf(c: CountryNumbers): string[] {
  return [...new Set([c.general, ...Object.values(c.services)])];
}

export interface NumberResult {
  country: string;
  ok: boolean;
  problems: string[];
}

/**
 * Checks the dataset against the snapshots (id → text, already checked against their pins): every
 * quote of a checked source verbatim in its snapshot and showing the numbers it claims, every number
 * of a country claimed by a quote of one of its checked sources; a country without a checked source
 * only if listed in UNCHECKED_NUMBER_COUNTRIES.
 */
export function checkNumbers(
  snapshots: ReadonlyMap<string, string>,
  countries: readonly CountryNumbers[] = COUNTRY_NUMBERS,
  unchecked: readonly string[] = UNCHECKED_NUMBER_COUNTRIES,
): NumberResult[] {
  return countries.map((c) => {
    const problems: string[] = [];
    const checked = c.sources.filter((s): s is NumberSource & { check: NumberCheck } => s.check !== undefined);
    if (checked.length === 0) {
      if (!unchecked.includes(c.country)) problems.push('no checked source (and not in UNCHECKED_NUMBER_COUNTRIES)');
      return { country: c.country, ok: problems.length === 0, problems };
    }
    if (unchecked.includes(c.country)) problems.push('listed in UNCHECKED_NUMBER_COUNTRIES but has a checked source');
    const shown = new Set<string>();
    for (const s of checked) {
      const text = snapshots.get(s.check.id);
      if (text === undefined) {
        problems.push(`${s.check.id}: no snapshot`);
        continue;
      }
      const page = normalizePage(text);
      for (const q of s.check.quotes) {
        if (!includesExcerpt(page, normalizeStep(q.text))) problems.push(`${s.check.id}: quote not in the source: "${q.text}"`);
        for (const n of q.numbers) {
          if (quoteShows(q.text, n)) shown.add(n);
          else problems.push(`${s.check.id}: the quote does not show ${n}: "${q.text}"`);
        }
      }
    }
    for (const n of numbersOf(c)) if (!shown.has(n)) problems.push(`${n} is not shown by a quote of a checked source`);
    return { country: c.country, ok: problems.length === 0, problems };
  });
}

/** The checked sources of the dataset, one per snapshot id (several countries may cite one). */
export function checkedSources(countries: readonly CountryNumbers[] = COUNTRY_NUMBERS): (NumberSource & { check: NumberCheck })[] {
  const out = new Map<string, NumberSource & { check: NumberCheck }>();
  for (const c of countries) {
    for (const s of c.sources) {
      if (!s.check) continue;
      const seen = out.get(s.check.id);
      if (seen && (seen.url !== s.url || seen.accessed !== s.accessed || seen.check.fileSha256 !== s.check.fileSha256)) {
        throw new Error(`${s.check.id}: cited with different URLs, dates or hashes`);
      }
      out.set(s.check.id, { ...s, check: s.check });
    }
  }
  return [...out.values()];
}

/** The committed snapshots checked against their pins (URL, date, format, file and text hash). */
export function numberSnapshots(problems: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const versions = new Set<string>();
  for (const s of checkedSources()) {
    let snap: NumberSnapshot;
    try {
      snap = readNumberSnapshot(s.check.id);
    } catch (e) {
      problems.push(`${s.check.id}: ${e instanceof Error ? e.message : String(e)} (${numberSnapshotPath(s.check.id)})`);
      continue;
    }
    if (snap.url !== s.url) problems.push(`${s.check.id}: snapshot URL ${snap.url}, numbers.ts ${s.url}`);
    if (snap.retrieved !== s.accessed) problems.push(`${s.check.id}: snapshot retrieved ${snap.retrieved}, numbers.ts ${s.accessed}`);
    if (snap.format !== s.check.format) problems.push(`${s.check.id}: snapshot format ${snap.format}, numbers.ts ${s.check.format}`);
    if (snap.fileSha256 !== s.check.fileSha256) problems.push(`${s.check.id}: snapshot file hash ${snap.fileSha256}, numbers.ts ${s.check.fileSha256}`);
    const got = textSha256(snap.text);
    if (got !== s.check.textSha256) problems.push(`${s.check.id}: snapshot text hash ${got}, numbers.ts ${s.check.textSha256}`);
    if (snap.extractorVersion !== null) versions.add(snap.extractorVersion);
    out.set(s.check.id, snap.text);
  }
  // One extractor for every PDF snapshot: the drift check compares new text with one pdftotext.
  if (versions.size > 1) problems.push(`PDF snapshots extracted with different pdftotext versions: ${[...versions].join(', ')}`);
  return out;
}
