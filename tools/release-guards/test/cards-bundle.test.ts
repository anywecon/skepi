import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findTexts, hermesStrings, literalPatternsOf, patternsOf, probeOf, sourcedTexts, unsourcedTexts } from '../src/cards-bundle';

/** The hermesc that builds the mobile release bundle (the hermes-compiler of the app's react-native). */
function hermesc(): string {
  const reactNative = createRequire(new URL('../../../apps/mobile/package.json', import.meta.url)).resolve('react-native/package.json');
  const root = dirname(createRequire(reactNative).resolve('hermes-compiler/package.json'));
  const bin = { win32: 'win64-bin/hermesc.exe', darwin: 'osx-bin/hermesc', linux: 'linux64-bin/hermesc' }[process.platform as string];
  if (bin === undefined) throw new Error(`no hermesc for ${process.platform}`);
  return join(root, 'hermesc', bin);
}

const work = mkdtempSync(join(tmpdir(), 'skepi-cards-bundle-'));
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Hermes bytecode (-O, as in release builds) of a script holding these strings. */
function compile(name: string, strings: readonly string[]): Uint8Array {
  const js = join(work, `${name}.js`);
  const hbc = join(work, `${name}.hbc`);
  writeFileSync(js, `var strings = ${JSON.stringify(strings)};\nprint(strings.length);\n`, 'utf8');
  execFileSync(hermesc(), ['-emit-binary', '-O', '-out', hbc, js]);
  return new Uint8Array(readFileSync(hbc));
}

describe('cards bundle check', () => {
  const unsourced = unsourcedTexts();
  const sourced = sourcedTexts();

  it('has the 199 unsourced texts and a searchable probe for every text', () => {
    expect(unsourced).toHaveLength(199);
    expect(sourced).toHaveLength(111);
    expect(unsourced.filter((t) => probeOf(t) === null)).toEqual([]);
    // Shorter than 16 characters: no probe; matched as an exact whole string instead.
    const short = sourced.filter((t) => probeOf(t) === null);
    expect(short).toEqual(['Access EMS.']);
    for (const t of short) expect(literalPatternsOf(t).length).toBeGreaterThan(0);
  });

  it('reads the Hermes string table: every sourced step, Greek and curly quotes as UTF-16, in a release-style build', () => {
    const greek = unsourced.find((t) => /\p{Script=Greek}/u.test(t)) ?? '';
    const bundle = compile('all', [...sourced, greek, 'S.K.E.P.I. keeps the key of its encrypted database']);
    const strings = hermesStrings(bundle) ?? [];
    for (const t of sourced) expect(strings).toContain(t);
    expect(strings).toContain(greek);
    expect(findTexts([bundle], sourced)).toEqual(sourced);
    expect(findTexts([bundle], unsourced)).toEqual([greek]);
  });

  it('matches a short step only as a whole Hermes string, not packed inside a longer one', () => {
    const packed = compile('packed', ['Access EMS immediately. Heatstroke is life-threatening.', 'Access EMS.K.E.P.I. keeps the key']);
    // The bytes are there (Hermes packs strings into each other), the string is not.
    expect(Buffer.from(packed).includes(Buffer.from('Access EMS.', 'utf8'))).toBe(true);
    expect(hermesStrings(packed)).not.toContain('Access EMS.');
    expect(findTexts([packed], ['Access EMS.'])).toEqual([]);
    const exact = compile('exact', ['Access EMS immediately.', 'Access EMS.', 'S.K.E.P.I. keeps the key']);
    expect(findTexts([exact], ['Access EMS.'])).toEqual(['Access EMS.']);
  });

  it('matches a short step only as a whole JavaScript string literal', () => {
    const found = (js: string): string[] => findTexts([new Uint8Array(Buffer.from(js, 'utf8'))], ['Access EMS.']);
    expect(found('Y(Ka,257,`Access EMS.`),Y(Ka,257,`Apply direct pressure`)')).toEqual(['Access EMS.']);
    expect(found('var a="Access EMS.";')).toEqual(['Access EMS.']);
    expect(found("var a='Access EMS.';")).toEqual(['Access EMS.']);
    expect(found('var a="Access EMS. Then wait.";')).toEqual([]);
    expect(found('var a="Call 112. Access EMS.";')).toEqual([]);
    expect(found('var a="Access EMS.\';')).toEqual([]);
    expect(found('var a="Access EMS immediately.";')).toEqual([]);
  });

  it('refuses Hermes bytecode of an unknown version and passes non-Hermes files to the text search', () => {
    const bundle = Buffer.from(compile('version', ['Access EMS.']));
    bundle.writeUInt32LE(100, 8);
    expect(() => hermesStrings(new Uint8Array(bundle))).toThrow(/version 100/);
    expect(hermesStrings(new Uint8Array(Buffer.from('var a="Access EMS.";', 'utf8')))).toBeNull();
    expect(() => literalPatternsOf('say "stop"')).toThrow(/quotes/);
  });

  it('no sourced step equals or contains an unsourced text or its probe (the two lists cannot be confused)', () => {
    for (const s of sourced) {
      for (const u of unsourced) {
        expect(s.includes(u)).toBe(false);
        expect(s.includes(probeOf(u) ?? u)).toBe(false);
      }
    }
  });

  it('finds text in UTF-8, in UTF-16LE (Hermes strings) and as \\u escapes (esbuild), also next to escapes', () => {
    const english = unsourced[0] ?? '';
    const greek = unsourced.find((t) => /\p{Script=Greek}/u.test(t)) ?? '';
    const curly = sourced.find((t) => t.includes('’')) ?? '';
    const js = Buffer.from(`var a="${english.replace(/"/g, '\\"')}";`, 'utf8');
    const hermes = Buffer.concat([Buffer.from([0, 1, 2, 3]), Buffer.from(greek, 'utf16le'), Buffer.from([9, 9])]);
    const asEsbuild = (t: string): string => t.replace(/[^ -~]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const esbuild = Buffer.from(`var b="${asEsbuild(curly)}";`, 'latin1');
    expect(findTexts([new Uint8Array(js)], unsourced)).toContain(english);
    expect(findTexts([new Uint8Array(hermes)], unsourced)).toContain(greek);
    expect(findTexts([new Uint8Array(esbuild)], sourced)).toContain(curly);
    expect(patternsOf(curly)).toHaveLength(4);
  });

  it('passes a bundle without card text', () => {
    const bundle = Buffer.from('var cards=[{id:"cpr",title:"CPR: unresponsive and not breathing normally (adult)",steps:[]}];', 'utf8');
    expect(findTexts([new Uint8Array(bundle)], [...unsourced, ...sourced])).toEqual([]);
  });
});
