/**
 * Emergency-card text in the built bundles (the Android Hermes bundle, the iOS main.jsbundle, the
 * desktop's Vite assets):
 * - unsourced texts (the cards' former adapted US public-domain steps and their Greek translation, which
 *   are no verbatim source text; data/unsourced-card-texts.json) must never be in any bundle;
 * - sourced texts (the verbatim IFRC, CDC and Ready.gov excerpts of @skepi/emergency-cards) may be in a
 *   bundle only when the committed source-check lock records a passed tools/cards-source-check of
 *   exactly those steps.
 *
 * A text is searched as its longest piece without characters a bundler may escape (ASCII quotes,
 * backslash, line breaks), in UTF-8 (JavaScript), UTF-16LE (Hermes keeps non-ASCII strings as UTF-16)
 * and with non-ASCII characters as \uXXXX escapes (esbuild's ASCII output). A text too short for such
 * a probe (e.g. "Access EMS.") must match exactly: a whole entry of the Hermes string table, or a whole
 * JavaScript string literal between matching quotes; never a piece of a longer string.
 */
import { readFileSync } from 'node:fs';
import { CARDS } from '@skepi/emergency-cards';

interface UnsourcedFile {
  texts: { card: string; locale: string; text: string }[];
}

/** The former card texts without a verbatim source (never shipped). */
export function unsourcedTexts(): string[] {
  const data = JSON.parse(readFileSync(new URL('../data/unsourced-card-texts.json', import.meta.url), 'utf8')) as UnsourcedFile;
  return data.texts.map((t) => t.text);
}

/** The verbatim source excerpts the cards ship. */
export function sourcedTexts(): string[] {
  return CARDS.flatMap((c) => c.steps.map((s) => s.text));
}

/** The longest piece of a text without characters a bundler may escape; null when shorter than 16. */
export function probeOf(text: string): string | null {
  const best = text.split(/["'`\\\n\r\t]/).reduce((a, b) => (b.length > a.length ? b : a), '');
  return best.trim().length >= 16 ? best : null;
}

/** The probe with every non-ASCII UTF-16 code unit written as a JavaScript \uXXXX escape. */
function escaped(probe: string, upper: boolean): string {
  let out = '';
  for (let i = 0; i < probe.length; i += 1) {
    const code = probe.charCodeAt(i);
    if (code < 0x80) {
      out += probe.charAt(i);
      continue;
    }
    const hex = code.toString(16).padStart(4, '0');
    out += `\\u${upper ? hex.toUpperCase() : hex}`;
  }
  return out;
}

/** The byte patterns that reveal a text in a bundle. */
export function patternsOf(text: string): Buffer[] {
  const probe = probeOf(text);
  if (probe === null) return [];
  const out = [Buffer.from(probe, 'utf8'), Buffer.from(probe, 'utf16le')];
  const lower = escaped(probe, false);
  if (lower !== probe) out.push(Buffer.from(lower, 'latin1'), Buffer.from(escaped(probe, true), 'latin1'));
  return out;
}

const HBC_MAGIC = 0x1f1903c103bc1fc6n;
/**
 * Hermes bytecode versions whose section layout hermesStrings knows: 98 (hermes-compiler of React Native
 * 0.86) and 99 (React Native 0.88, hermes-compiler 260318099.0.5). Checked against facebook/hermes at
 * 913d31ac (version 99): same BytecodeFileHeader offsets and size (128), SmallFuncHeader (12 bytes),
 * visitBytecodeSegmentsInOrder and SmallStringTableEntry / OverflowStringTableEntry encoding as in 98.
 */
const HBC_VERSIONS: ReadonlySet<number> = new Set([98, 99]);
/** BytecodeFileHeader (128 bytes) and SmallFuncHeader (12 bytes) of these versions. */
const HBC_HEADER_SIZE = 128;
const HBC_FUNCTION_HEADER_SIZE = 12;

/**
 * The string table of a Hermes bytecode file, or null when the file is not Hermes bytecode. Sections
 * follow the header in this order, each 4-byte aligned: function headers, string kinds, identifier
 * hashes, the small string table, the overflow string table, the string storage. A small entry packs
 * isUTF16 (bit 0), offset (23 bits) and length (8 bits; 255 = the offset indexes the overflow table).
 * Entries may overlap in the storage (Hermes packs a string into the start or end of another), so only
 * the table tells where a string begins and ends.
 */
export function hermesStrings(bytes: Uint8Array): string[] | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < HBC_HEADER_SIZE || buf.readBigUInt64LE(0) !== HBC_MAGIC) return null;
  const version = buf.readUInt32LE(8);
  if (!HBC_VERSIONS.has(version)) {
    throw new Error(`Hermes bytecode version ${String(version)} is not known to the card bundle scan (known: ${[...HBC_VERSIONS].join(', ')})`);
  }
  const u32 = (offset: number): number => buf.readUInt32LE(offset);
  if (u32(0x20) !== buf.length) throw new Error('Hermes bytecode: the file length in the header does not match the file');
  const functions = u32(0x28);
  const kinds = u32(0x2c);
  const identifiers = u32(0x30);
  const count = u32(0x34);
  const overflowCount = u32(0x38);
  const storageSize = u32(0x3c);
  const table = HBC_HEADER_SIZE + functions * HBC_FUNCTION_HEADER_SIZE + 4 * kinds + 4 * identifiers;
  const overflowTable = table + 4 * count;
  const storage = overflowTable + 8 * overflowCount;
  if (storage + storageSize > buf.length) throw new Error('Hermes bytecode: the string storage runs past the end of the file');
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const entry = u32(table + 4 * i);
    const utf16 = (entry & 1) === 1;
    let offset = (entry >>> 1) & 0x7fffff;
    let length = entry >>> 24;
    if (length === 255) {
      if (offset >= overflowCount) throw new Error(`Hermes bytecode: string ${String(i)} points past the overflow table`);
      length = u32(overflowTable + 8 * offset + 4);
      offset = u32(overflowTable + 8 * offset);
    }
    const size = utf16 ? 2 * length : length;
    if (offset + size > storageSize) throw new Error(`Hermes bytecode: string ${String(i)} runs past the string storage`);
    out.push(buf.toString(utf16 ? 'utf16le' : 'latin1', storage + offset, storage + offset + size));
  }
  return out;
}

/** Characters that a bundler writes escaped inside a string literal (the literal match does not model escaping). */
const LITERAL_ESCAPED = /["'`\\\n\r]/;

/** The text as a whole JavaScript string literal between matching quotes, raw or with \uXXXX escapes. */
export function literalPatternsOf(text: string): Buffer[] {
  if (LITERAL_ESCAPED.test(text)) throw new Error(`no exact literal match for a text with quotes, backslashes or line breaks: "${text}"`);
  const bodies = [text, escaped(text, false), escaped(text, true)].filter((b, i, all) => all.indexOf(b) === i);
  return ['"', "'", '`'].flatMap((q) => bodies.map((b) => Buffer.from(`${q}${b}${q}`, 'utf8')));
}

interface Haystack {
  bytes: Buffer;
  /** The Hermes string table, or null for a JavaScript bundle. */
  strings: ReadonlySet<string> | null;
}

/**
 * The texts found in any of the bundles: by probe, or for a text too short for a probe, as an exact
 * whole string (Hermes string table entry or JavaScript string literal).
 */
export function findTexts(bundles: readonly Uint8Array[], texts: readonly string[]): string[] {
  const haystacks: Haystack[] = bundles.map((b) => {
    const strings = hermesStrings(b);
    return { bytes: Buffer.from(b), strings: strings === null ? null : new Set(strings) };
  });
  return texts.filter((t) => {
    const patterns = patternsOf(t);
    if (patterns.length > 0) return haystacks.some((h) => patterns.some((p) => h.bytes.includes(p)));
    const literals = literalPatternsOf(t);
    return haystacks.some((h) => (h.strings === null ? literals.some((p) => h.bytes.includes(p)) : h.strings.has(t)));
  });
}
