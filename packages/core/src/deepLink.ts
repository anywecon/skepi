/**
 * Incoming deep links (`skepi://`, which any app or web page can open) are cut off before React Navigation
 * parses them: decode-uri-component 0.2.2, reached through expo-router's query-string 7, takes quadratic time
 * on long malformed input (GHSA-qr28-fpjm-wq7f; docs/threat-model.md, "Dependency risk acceptance").
 * No link the app handles comes near this length, and the app's own navigation does not pass through here.
 */
export const MAX_DEEP_LINK_CHARS = 2048;

/** Where the app starts when the link that launched it was refused: the same screen as a normal launch. */
const START_PATH = '/';

/**
 * The link to hand to the router, for expo-router's `redirectSystemPath`. An oversized link is ignored:
 * `null` while the app is running (the router does not navigate), the start screen when it launched the app.
 */
export function admitDeepLink(path: string, initial: boolean): string | null {
  if (path.length <= MAX_DEEP_LINK_CHARS) return path;
  return initial ? START_PATH : null;
}
