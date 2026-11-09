import type { InstalledPack } from '@skepi/contracts';

/**
 * Opens the ZIM packs that may be opened: verified ones first, then unverified ones the user consented
 * to (never anything else; models and maps never open here). A ZIM declares its own UUID, and the
 * native registry refuses a second file with the UUID of an open archive, so the order decides that a
 * verified pack keeps its id. An archive is kept only when it came from the pack's own file.
 */
export async function openZimPacks<T extends { path: string }>(
  packs: readonly InstalledPack[],
  open: (path: string) => Promise<T>,
): Promise<(T & { packId: string; verified: boolean })[]> {
  const openable = packs.filter((p) => p.kind === 'zim' && (p.verified || p.consentAt !== null));
  const ordered = [...openable.filter((p) => p.verified), ...openable.filter((p) => !p.verified)];
  const out: (T & { packId: string; verified: boolean })[] = [];
  for (const p of ordered) {
    try {
      const info = await open(p.path);
      if (info.path !== p.path) continue;
      out.push({ ...info, packId: p.id, verified: p.verified });
    } catch {
      // A file that libzim refuses (corrupt, not a ZIM, or a duplicate UUID) is skipped; the Library shows it.
    }
  }
  return out;
}

/** A ZIM archive id as the native registries report it (a UUID). Anything else never opens. */
export function isArchiveId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/**
 * The "Unverified" label fails closed: it is hidden only when an open archive with exactly this id is
 * verified. An id the app does not know (a deep link with another spelling of an archive's id) shows it.
 */
export function showsUnverifiedLabel(archives: readonly { archiveId: string; verified: boolean }[], archiveId: string): boolean {
  return !archives.some((a) => a.archiveId === archiveId && a.verified);
}
