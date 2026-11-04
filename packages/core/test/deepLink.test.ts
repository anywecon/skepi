import { describe, expect, it } from 'vitest';
import { admitDeepLink, MAX_DEEP_LINK_CHARS } from '../src/deepLink';

const ofLength = (n: number): string => {
  const prefix = 'skepi:///article?title=';
  return prefix + '%ZZ'.repeat(n).slice(0, n - prefix.length);
};

describe('admitDeepLink', () => {
  it('passes a normal link unchanged, on launch and while running', () => {
    const link = 'skepi:///article?archiveId=abc&path=Water%20purification&title=Water';
    expect(admitDeepLink(link, true)).toBe(link);
    expect(admitDeepLink(link, false)).toBe(link);
  });

  it('passes a link of exactly the limit', () => {
    const link = ofLength(MAX_DEEP_LINK_CHARS);
    expect(link).toHaveLength(MAX_DEEP_LINK_CHARS);
    expect(admitDeepLink(link, false)).toBe(link);
  });

  it('ignores an oversized link while the app runs', () => {
    expect(admitDeepLink(ofLength(MAX_DEEP_LINK_CHARS + 1), false)).toBeNull();
    expect(admitDeepLink(ofLength(224 * 1024), false)).toBeNull();
  });

  it('starts on the start screen when an oversized link launched the app', () => {
    expect(admitDeepLink(ofLength(MAX_DEEP_LINK_CHARS + 1), true)).toBe('/');
    expect(admitDeepLink(ofLength(224 * 1024), true)).toBe('/');
  });
});
