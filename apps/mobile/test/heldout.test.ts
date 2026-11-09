import { beforeEach, describe, expect, it, vi } from 'vitest';

const zim = vi.hoisted(() => ({
  opened: [] as string[],
  readContentFile: (): Promise<string | null> =>
    Promise.resolve(JSON.stringify({ schema: 1, set: 'adversarial-heldout', archive: 'heldout/eval-heldout.zim', items: [] })),
  getRuntimeInfo: (): Promise<{ contentDir: string }> => Promise.resolve({ contentDir: '/data/content' }),
  openArchive: (path: string): Promise<never> => {
    zim.opened.push(path);
    // The test ends here: what matters is whether the archive was opened.
    return Promise.reject(new Error('opened'));
  },
}));

vi.mock('expo-zim', () => ({ ExpoZim: zim }));
vi.mock('../src/lib/content', () => ({
  activeProfile: () => ({ profile: {}, model: null }),
  ensureModel: () => Promise.resolve(null),
  knowledge: {},
  llama: {},
  ragArchives: () => [],
  ragConfigFor: () => ({}),
}));

const { runHeldout } = await import('../src/lib/heldout');

beforeEach(() => {
  zim.opened.length = 0;
});

describe('the held-out runner opens its unverified archive only after consent', () => {
  it('asks for the archive and opens nothing when the user declines', async () => {
    const asked: string[] = [];
    await expect(
      runHeldout(
        () => undefined,
        (archive) => {
          asked.push(archive);
          return Promise.resolve(false);
        },
      ),
    ).rejects.toThrow(/no consent/);
    expect(asked).toEqual(['heldout/eval-heldout.zim']);
    expect(zim.opened).toEqual([]);
  });

  it('opens it after consent', async () => {
    await expect(runHeldout(() => undefined, () => Promise.resolve(true))).rejects.toThrow('opened');
    expect(zim.opened).toEqual(['/data/content/heldout/eval-heldout.zim']);
  });
});
