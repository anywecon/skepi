import { admitDeepLink, MAX_DEEP_LINK_CHARS } from '@skepi/core';

/**
 * expo-router calls this for the URL that launched the app and for every URL while it runs, before React
 * Navigation parses them. Oversized links stop here (packages/core/src/deepLink.ts).
 */
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): string | null {
  const admitted = admitDeepLink(path, initial);
  if (__DEV__ && admitted !== path) {
    console.warn(`[skepi] deep link of ${String(path.length)} chars ignored (limit ${String(MAX_DEEP_LINK_CHARS)})`);
  }
  return admitted;
}
