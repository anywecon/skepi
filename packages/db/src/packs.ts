import type { Row, SqlExecutor } from './db';

export type PackKind = 'zim' | 'gguf' | 'pmtiles' | 'places';
export type PackSource = 'download' | 'import' | 'provisioned' | 'p2p';

/** One installed file. Unverified packs exist only for ZIM (imported, opened after explicit consent). */
export interface PackRow {
  id: string;
  kind: PackKind;
  version: string;
  title: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  verified: boolean;
  /** Catalog sequence that vouched for the file (verified packs only). */
  catalogSeq: number | null;
  license: string | null;
  source: PackSource;
  /** When the user consented to open an unverified ZIM (null: not opened). */
  consentAt: number | null;
  installedAt: number;
  lastOpenedAt: number | null;
  /** Native identity of the file when it was last hashed (null: never stamped; hashed at startup). */
  fileStamp: string | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null;
}

function toPack(r: Row): PackRow {
  return {
    id: String(r.id),
    kind: String(r.kind) as PackKind,
    version: String(r.version),
    title: String(r.title),
    path: String(r.path),
    sizeBytes: num(r.size_bytes) ?? 0,
    sha256: String(r.sha256),
    verified: num(r.verified) === 1,
    catalogSeq: num(r.catalog_seq),
    license: typeof r.license === 'string' ? r.license : null,
    source: String(r.source) as PackSource,
    consentAt: num(r.consent_at),
    installedAt: num(r.installed_at) ?? 0,
    lastOpenedAt: num(r.last_opened_at),
    fileStamp: typeof r.file_stamp === 'string' ? r.file_stamp : null,
  };
}

/** Registers (or replaces) a pack; called in the same transaction as the atomic rename. */
export async function upsertPack(db: SqlExecutor, p: PackRow): Promise<void> {
  await db.execute(
    `INSERT INTO packs (id, kind, version, title, path, size_bytes, sha256, verified, catalog_seq, license, source, consent_at, installed_at, last_opened_at, file_stamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, version = excluded.version, title = excluded.title, path = excluded.path,
       size_bytes = excluded.size_bytes, sha256 = excluded.sha256, verified = excluded.verified, catalog_seq = excluded.catalog_seq,
       license = excluded.license, source = excluded.source, consent_at = excluded.consent_at, installed_at = excluded.installed_at,
       last_opened_at = excluded.last_opened_at, file_stamp = excluded.file_stamp`,
    [
      p.id,
      p.kind,
      p.version,
      p.title,
      p.path,
      p.sizeBytes,
      p.sha256,
      p.verified ? 1 : 0,
      p.catalogSeq,
      p.license,
      p.source,
      p.consentAt,
      p.installedAt,
      p.lastOpenedAt,
      p.fileStamp,
    ],
  );
}

export async function listPacks(db: SqlExecutor): Promise<PackRow[]> {
  const { rows } = await db.execute('SELECT * FROM packs ORDER BY kind, id');
  return rows.map(toPack);
}

export async function getPack(db: SqlExecutor, id: string): Promise<PackRow | null> {
  const { rows } = await db.execute('SELECT * FROM packs WHERE id = ?', [id]);
  const r = rows[0];
  return r ? toPack(r) : null;
}

export async function findPackByPath(db: SqlExecutor, path: string): Promise<PackRow | null> {
  const { rows } = await db.execute('SELECT * FROM packs WHERE path = ?', [path]);
  const r = rows[0];
  return r ? toPack(r) : null;
}

export async function removePack(db: SqlExecutor, id: string): Promise<void> {
  await db.execute('DELETE FROM packs WHERE id = ?', [id]);
}

/** Explicit consent to open an unverified ZIM (permanent label, JavaScript always off). */
export async function setConsent(db: SqlExecutor, id: string, at: number | null): Promise<void> {
  await db.execute('UPDATE packs SET consent_at = ? WHERE id = ? AND verified = 0', [at, id]);
}

export async function markOpened(db: SqlExecutor, id: string, at: number): Promise<void> {
  await db.execute('UPDATE packs SET last_opened_at = ? WHERE id = ?', [at, id]);
}
