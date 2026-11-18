/**
 * No private key may be committed (CI guard, `verify` job). Signing keys live outside the repository
 * (docs/release-signing.md); the local test mirror's certificates are generated on demand
 * (e2e/mirror/gen-certs.mjs). A tracked file fails when its name is a key or keystore format, or when its
 * content holds a PEM private key block, whatever the file name.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Repository-relative paths allowed despite matching, each with a dated reason in a comment. Empty since
 * 2026-11-18 (the test mirror's server.key was untracked); additions need the maintainer's decision.
 */
export const PRIVATE_KEY_ALLOWLIST: readonly string[] = [];

/** Key and keystore formats, refused by name alone (binary formats have no PEM marker to look for). */
export const KEY_FILE_EXTENSIONS = ['.key', '.p12', '.pfx', '.jks', '.keystore'] as const;

/** `-----BEGIN PRIVATE KEY-----`, `... RSA PRIVATE KEY-----`, `... OPENSSH ...`, `... ENCRYPTED ...`, PGP blocks. */
const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

export interface PrivateKeyFinding {
  path: string;
  reason: string;
}

/** Why `path` (with this content) counts as a private key, or null. */
export function privateKeyReason(path: string, content: Buffer): string | null {
  const lower = path.toLowerCase();
  const ext = KEY_FILE_EXTENSIONS.find((e) => lower.endsWith(e));
  // latin1 maps every byte to one character, so the marker is found in binary files too.
  const pem = PEM_PRIVATE_KEY.exec(content.toString('latin1'));
  if (pem && lower.endsWith('.pem')) return `PEM file with a private key (${pem[0]})`;
  if (pem) return `contains a PEM private key block (${pem[0]})`;
  if (ext) return `key or keystore file name (*${ext})`;
  return null;
}

/** Findings for the given files, minus the allowlist. */
export function findPrivateKeys(
  files: Iterable<{ path: string; content: Buffer }>,
  allowlist: readonly string[] = PRIVATE_KEY_ALLOWLIST,
): PrivateKeyFinding[] {
  const allowed = new Set(allowlist);
  const findings: PrivateKeyFinding[] = [];
  for (const { path, content } of files) {
    if (allowed.has(path)) continue;
    const reason = privateKeyReason(path, content);
    if (reason) findings.push({ path, reason });
  }
  return findings;
}

/** Every file git tracks in `root` (index), read from the working tree; symlinks and submodules by name only. */
export function* trackedFiles(root: string): Generator<{ path: string; content: Buffer }> {
  const git = spawnSync('git', ['ls-files', '-z', '--cached'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
  if (git.status !== 0) throw new Error(`git ls-files failed in ${root}: ${git.error?.message ?? git.stderr.toString()}`);
  for (const path of git.stdout.toString('utf8').split('\0').filter(Boolean)) {
    const file = join(root, path);
    let content = Buffer.alloc(0);
    try {
      if (lstatSync(file).isFile()) content = readFileSync(file);
    } catch {
      // Tracked but deleted in the working tree: the name is still checked.
    }
    yield { path, content };
  }
}
