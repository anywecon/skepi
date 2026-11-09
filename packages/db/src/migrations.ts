/**
 * Numbered, forward-only migrations shared by mobile (op-sqlite + SQLCipher) and, later, desktop
 * (rusqlite). A released migration is never edited: a change is a new, higher number. Each migration
 * runs in one transaction together with its row in `schema_migrations`.
 */
export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'packs_and_settings',
    statements: [
      // Installed packs: the source of truth for what the app may open (architecture: data model).
      `CREATE TABLE packs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('zim','gguf','pmtiles','places')),
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        verified INTEGER NOT NULL CHECK (verified IN (0,1)),
        catalog_seq INTEGER,
        license TEXT,
        source TEXT NOT NULL CHECK (source IN ('download','import','provisioned')),
        consent_at INTEGER,
        installed_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        CHECK (verified = 1 OR kind = 'zim'),
        CHECK (verified = 1 OR catalog_seq IS NULL)
      )`,
      'CREATE INDEX packs_sha256 ON packs (sha256)',
      'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ],
  },
  {
    version: 2,
    name: 'energy_samples',
    statements: [
      // Measured battery cost per action (blackout mode, "≈ x% battery"); never leaves the device.
      `CREATE TABLE energy_samples (
        action TEXT NOT NULL,
        tier TEXT NOT NULL,
        battery_delta_pct REAL NOT NULL CHECK (battery_delta_pct >= 0 AND battery_delta_pct <= 100),
        duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
        created_at INTEGER NOT NULL
      )`,
      'CREATE INDEX energy_samples_action ON energy_samples (action, tier, created_at)',
    ],
  },
  {
    version: 3,
    name: 'packs_source_p2p',
    statements: [
      // Packs received from another phone (P2P, Phase 2a) record their provenance. SQLite cannot
      // change a CHECK constraint in place: rebuild the table with the same columns and rules.
      `CREATE TABLE packs_v3 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('zim','gguf','pmtiles','places')),
        version TEXT NOT NULL,
        title TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        verified INTEGER NOT NULL CHECK (verified IN (0,1)),
        catalog_seq INTEGER,
        license TEXT,
        source TEXT NOT NULL CHECK (source IN ('download','import','provisioned','p2p')),
        consent_at INTEGER,
        installed_at INTEGER NOT NULL,
        last_opened_at INTEGER,
        CHECK (verified = 1 OR kind = 'zim'),
        CHECK (verified = 1 OR catalog_seq IS NULL)
      )`,
      'INSERT INTO packs_v3 SELECT id, kind, version, title, path, size_bytes, sha256, verified, catalog_seq, license, source, consent_at, installed_at, last_opened_at FROM packs',
      'DROP TABLE packs',
      'ALTER TABLE packs_v3 RENAME TO packs',
      'CREATE INDEX packs_sha256 ON packs (sha256)',
    ],
  },
  {
    version: 4,
    name: 'packs_file_stamp',
    statements: [
      // Identity of the installed file when it was last hashed (size, modification and change
      // times, file id or inode; written by the native side). Startup hashes a pack again whenever
      // the stamp differs, so a same-size replacement cannot keep the verified state. NULL (packs
      // from before this migration) is hashed once.
      'ALTER TABLE packs ADD COLUMN file_stamp TEXT',
    ],
  },
];
