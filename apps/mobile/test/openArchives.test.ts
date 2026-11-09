import type { InstalledPack } from '@skepi/contracts';
import { describe, expect, it } from 'vitest';
import { openZimPacks } from '../src/lib/openArchives';

const UUID = '0f9e7c1a-1111-4222-8333-444455556666';

function pack(id: string, verified: boolean, consentAt: number | null): InstalledPack {
  return {
    id,
    kind: 'zim',
    version: verified ? '2026-09' : 'unverified',
    title: id,
    path: `/data/content/zim/${id}.zim`,
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    verified,
    source: verified ? 'download' : 'import',
    consentAt,
    license: null,
  };
}

/** The native registry: the first file to declare a UUID keeps it; a second one is refused. */
function registry(uuidOf: (path: string) => string): (path: string) => Promise<{ archiveId: string; path: string }> {
  const open = new Map<string, string>();
  return (path) => {
    const id = uuidOf(path);
    const other = open.get(id);
    if (other !== undefined && other !== path) return Promise.reject(new Error('ERR_ZIM_DUPLICATE'));
    open.set(id, path);
    return Promise.resolve({ archiveId: id, path });
  };
}

describe('openZimPacks', () => {
  it('an unverified ZIM claiming a verified pack’s UUID never takes its id, whatever the list order', async () => {
    // The unverified import sorts first by id and was consented to.
    const packs = [pack('import-aaaa', false, 1), pack('wikipedia_en_top_mini', true, null)];
    const opened = await openZimPacks(packs, registry(() => UUID));
    expect(opened.map((a) => [a.archiveId, a.packId, a.verified])).toEqual([[UUID, 'wikipedia_en_top_mini', true]]);
  });

  it('keeps an archive only when it came from the pack’s own file', async () => {
    const packs = [pack('wikipedia_en_top_mini', true, null)];
    const opened = await openZimPacks(packs, (path) => Promise.resolve({ archiveId: UUID, path: path.replace('wikipedia', 'other') }));
    expect(opened).toEqual([]);
  });

  it('opens nothing unverified without consent', async () => {
    const opened = await openZimPacks([pack('import-bbbb', false, null)], registry((p) => p));
    expect(opened).toEqual([]);
  });
});
