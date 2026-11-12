import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/keys';

const PLACES = join(REPO_ROOT, 'tools', 'catalog-builder', 'places');
const PIN = /^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;]+)((?:\s+--hash=sha256:[0-9a-f]{64})*)$/;

interface Pin {
  name: string;
  version: string;
  hashes: string[];
}

/** PEP 503 normalised project name: case and runs of `-`, `_`, `.` do not matter. */
const normalise = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/** The `name==version [--hash=...]` lines of a requirements file; anything else is an error. */
function readPins(file: string): Pin[] {
  const pins: Pin[] = [];
  for (const raw of readFileSync(join(PLACES, file), 'utf8').split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    const match = line.match(PIN);
    if (!match?.[1] || !match[2]) throw new Error(`${file}: not an exact pin: ${raw}`);
    const hashes = (match[3] ?? '').trim().split(/\s+/).filter((h) => h !== '');
    pins.push({ name: normalise(match[1]), version: match[2], hashes });
  }
  return pins;
}

const versions = (pins: Pin[]): Record<string, string> => Object.fromEntries(pins.map((p) => [p.name, p.version]));

describe('places requirements: requirements.txt pins the versions of requirements-ci.txt', () => {
  const local = readPins('requirements.txt');
  const ci = readPins('requirements-ci.txt');

  it('lists every package once', () => {
    expect(new Set(local.map((p) => p.name)).size).toBe(local.length);
    expect(new Set(ci.map((p) => p.name)).size).toBe(ci.length);
  });

  it('pins exactly the same packages at the same versions', () => {
    expect(versions(local)).toEqual(versions(ci));
  });

  it('keeps the hashes in requirements-ci.txt only', () => {
    expect(local.filter((p) => p.hashes.length > 0)).toEqual([]);
    expect(ci.filter((p) => p.hashes.length === 0)).toEqual([]);
  });
});
