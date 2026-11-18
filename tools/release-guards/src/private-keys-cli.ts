/**
 * Usage: tsx src/private-keys-cli.ts [repo root, default: the current directory]
 * Fails (exit 1) when a tracked file is a private key or keystore (src/private-keys.ts).
 */
import { resolve } from 'node:path';
import { PRIVATE_KEY_ALLOWLIST, findPrivateKeys, trackedFiles } from './private-keys';

const root = resolve(process.argv[2] ?? '.');
let count = 0;
const findings = findPrivateKeys(
  (function* counted() {
    for (const f of trackedFiles(root)) {
      count += 1;
      yield f;
    }
  })(),
);
if (findings.length > 0) {
  for (const f of findings) console.error(`PRIVATE KEY: ${f.path}: ${f.reason}`);
  console.error(
    `${findings.length} tracked file(s) look like private keys. Remove them from git (git rm --cached) and keep keys outside the ` +
      'repository; an exception needs the maintainer\'s decision in PRIVATE_KEY_ALLOWLIST (tools/release-guards/src/private-keys.ts).',
  );
  process.exit(1);
}
console.log(`NO PRIVATE KEYS: PASS (${count} tracked files, allowlist: ${PRIVATE_KEY_ALLOWLIST.length === 0 ? 'empty' : PRIVATE_KEY_ALLOWLIST.join(', ')})`);
