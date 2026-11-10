export type PackKind = 'zim' | 'gguf' | 'pmtiles' | 'places';

/** What a signed catalog says about a pack (structural subset of `@skepi/core` CatalogPack). */
export interface CatalogEntry {
  id: string;
  kind: PackKind;
  version: string;
  file: string;
  title: { en: string; el?: string };
  sizeBytes: number;
  sha256: string;
  urls: readonly string[];
  license: string;
}

export interface InstalledPack {
  id: string;
  kind: PackKind;
  version: string;
  title: string;
  /** Real filesystem path inside app storage. */
  path: string;
  sizeBytes: number;
  sha256: string;
  /** The SHA-256 matched an entry of a valid signed catalog. */
  verified: boolean;
  source: 'download' | 'import' | 'provisioned' | 'p2p';
  /** Unverified ZIM only: when the user agreed to open it (null: not opened). */
  consentAt: number | null;
  license: string | null;
}

export type DownloadPhase = 'queued' | 'waiting-for-network' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'cancelled';

export interface DownloadProgress {
  packId: string;
  phase: DownloadPhase;
  /** Bytes downloaded (or hashed while verifying). */
  bytes: number;
  totalBytes: number;
  /** Index of the mirror in use (catalog `urls`). */
  mirror: number;
  /** Set when a mirror's file did not match the catalog hash (it was deleted, next mirror tried). */
  rejectedMirrors: number;
  error: string | null;
}

export interface VerifyResult {
  ok: boolean;
  sha256: string;
  expected: string | null;
  /** The current signed catalog revokes this hash (never passes). */
  revoked?: boolean;
}

/**
 * The only way content enters the device (architecture: "Content inputs"): downloads from catalog
 * mirrors and imported files, both hashed before anything opens them.
 */
export interface ContentStore {
  listInstalled(): Promise<InstalledPack[]>;
  download(entry: CatalogEntry, signal: AbortSignal): AsyncIterable<DownloadProgress>;
  importFile(uri: string): Promise<InstalledPack>;
  verify(pack: InstalledPack): Promise<VerifyResult>;
  remove(packId: string): Promise<void>;
}
