import type { InstalledPack } from '@skepi/contracts';
import { describe, expect, it } from 'vitest';
import { isArchiveId, openZimPacks, showsUnverifiedLabel } from '../src/lib/openArchives';

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

describe('the Unverified label fails closed', () => {
  const archives = [
    { archiveId: UUID, verified: true },
    { archiveId: '11111111-2222-4333-8444-555566667777', verified: false },
  ];

  it('is hidden only for an open, verified archive with exactly that id', () => {
    expect(showsUnverifiedLabel(archives, UUID)).toBe(false);
    expect(showsUnverifiedLabel(archives, '11111111-2222-4333-8444-555566667777')).toBe(true);
  });

  it('shows for an id the app does not know, however the deep link spelled it', () => {
    for (const id of [UUID.toUpperCase(), `x@${UUID}`, `${UUID}:80`, '', 'not-an-archive']) {
      expect(showsUnverifiedLabel(archives, id)).toBe(true);
    }
  });

  it('accepts only UUID archive ids', () => {
    expect(isArchiveId(UUID)).toBe(true);
    for (const id of [`x@${UUID}`, `${UUID}:80`, `${UUID}/`, '', 'zim']) expect(isArchiveId(id)).toBe(false);
  });
});
