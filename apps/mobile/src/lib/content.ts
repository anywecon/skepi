import type { InstalledModel, InstalledPack, LoadedModel } from '@skepi/contracts';
import {
  installedRegions,
  resolveInferenceProfile,
  SYSTEM_PROMPT,
  type ArchiveRef,
  type RegionInfo,
  type Catalog,
  type InferenceBackend,
  type InferenceProfile,
  type RagConfig,
} from '@skepi/core';
import { getSetting, setSetting } from '@skepi/db';
import { ExpoDeviceProfile, type CpuInfo } from 'expo-device-profile';
import { createZimKnowledgeEngine, ExpoZim, type ZimArchiveInfo, type ZimRuntimeInfo } from 'expo-zim';
import { create } from 'zustand';
import {
  parsePinnedKeysFile,
  parseUpdateUrls,
  selectCatalog,
  sourceFromBase64,
  trustedKeys,
  type CatalogRejectionReport,
  type CatalogSource,
  type CatalogState,
} from './catalog';
import { AndroidContentStore, readAcceptedCatalog, readEmbeddedCatalog, writeAcceptedCatalog, type ReconcileReport } from './contentStore';
import { appDb } from './db';
import { LlamaEngine } from './llamaEngine';
import { openZimPacks } from './openArchives';


export const knowledge = createZimKnowledgeEngine();
export const llama = new LlamaEngine();

/** An installed, verified map or places pack with its country (from the signed catalog). */
export interface RegionalPack {
  id: string;
  path: string;
  region: RegionInfo | null;
}

/** The open archive of an installed pack: unverified packs carry a permanent label. */
export type OpenArchive = ZimArchiveInfo & { packId: string; verified: boolean };

export interface VerifyingProgress {
  file: string;
  percent: number;
}

interface ContentState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Startup hashing of files the database does not know yet (provisioned or changed). */
  verifying: VerifyingProgress | null;
  runtime: ZimRuntimeInfo | null;
  catalog: CatalogState | null;
  packs: InstalledPack[];
  reconcile: ReconcileReport | null;
  archives: OpenArchive[];
  models: InstalledModel[];
  /**
   * Verified map packs, every installed country at once (one style, one source each; global maps).
   * Unverified map files are never opened.
   */
  mapPacks: RegionalPack[];
  /** Verified places packs (search, the emergency POI layer and the country of a position). */
  placesPacks: RegionalPack[];
  placesPaths: string[];
  cpu: CpuInfo | null;
  totalRamMb: number;
  /** Developer setting: force the T1 profile on any device (persisted in app.db). */
  simulateT1: boolean;
  setSimulateT1: (on: boolean) => void;
  /** Developer setting: GPU/NPU experiment (in memory; CPU on every start). */
  backend: InferenceBackend;
  setBackend: (backend: InferenceBackend) => void;
  /** Downloads on metered networks after the user confirmed (persisted; default Wi-Fi only). */
  allowMetered: boolean;
  setAllowMetered: (on: boolean) => void;
  bootstrap: () => Promise<void>;
  /** Re-reads installed packs and re-opens archives (after a download, import, consent or removal). */
  refresh: () => Promise<void>;
  /** Verifies and adopts a newer catalog (catalog update); returns the rejection, if any. */
  adoptCatalog: (source: CatalogSource) => Promise<CatalogRejectionReport | null>;
}

export const contentStore = new AndroidContentStore(appDb, () => useContent.getState().catalog?.catalog ?? null);

async function openArchives(packs: readonly InstalledPack[]): Promise<OpenArchive[]> {
  return openZimPacks(packs, (path) => ExpoZim.openArchive(path));
}

async function loadCatalogState(): Promise<CatalogState> {
  const db = await appDb();
  const embedded = await readEmbeddedCatalog();
  if (!embedded) {
    return { catalog: null, origin: null, sha256: null, purpose: null, trusted: [], rejected: [], updateUrls: [] };
  }
  const pinned = parsePinnedKeysFile(embedded.pinnedKeys);
  const trusted = await trustedKeys(db, pinned);
  const sources: CatalogSource[] = [sourceFromBase64('embedded', embedded.catalog, embedded.signature)];
  const stored = await readAcceptedCatalog();
  if (stored) sources.push(sourceFromBase64('stored', stored.catalog, stored.signature));
  const chosen = await selectCatalog(db, sources, trusted);
  if (chosen.accepted && chosen.accepted.origin === 'embedded') await writeAcceptedCatalog(chosen.accepted);
  return {
    catalog: chosen.catalog,
    origin: chosen.origin,
    sha256: chosen.sha256,
    purpose: pinned.purpose,
    trusted,
    // An embedded catalog older than a downloaded one is expected (anti-rollback), not an error.
    rejected: chosen.rejected.filter((r) => !(r.origin === 'embedded' && r.reason === 'rollback')),
    updateUrls: parseUpdateUrls(embedded.sources),
  };
}

export const useContent = create<ContentState>((set, get) => ({
  status: 'idle',
  error: null,
  verifying: null,
  runtime: null,
  catalog: null,
  packs: [],
  reconcile: null,
  archives: [],
  models: [],
  mapPacks: [],
  placesPacks: [],
  placesPaths: [],
  cpu: null,
  totalRamMb: 0,
  simulateT1: false,
  setSimulateT1: (on) => {
    if (get().simulateT1 === on) return;
    set({ simulateT1: on });
    void appDb().then((db) => setSetting(db, 'dev.simulateT1', on));
    // The loaded model may not match the new profile; the next request reloads it.
    void llama.unload();
  },
  backend: 'cpu',
  setBackend: (backend) => {
    if (get().backend === backend) return;
    set({ backend });
    void llama.unload();
  },
  allowMetered: false,
  setAllowMetered: (on) => {
    set({ allowMetered: on });
    void appDb().then((db) => setSetting(db, 'downloads.allowMetered', on));
  },
  refresh: async () => {
    const packs = await contentStore.listInstalled();
    for (const a of get().archives) await ExpoZim.closeArchive(a.archiveId);
    const archives = await openArchives(packs);
    const models = packs
      .filter((p) => p.kind === 'gguf' && p.verified)
      .map((p) => ({ id: p.path.split('/').pop() ?? p.id, path: p.path, sizeBytes: p.sizeBytes }));
    // Only packs verified against a signed catalog render or are searched; every installed country
    // at once, in a stable order (pack id).
    const regions = installedRegions(get().catalog?.catalog ?? null, packs);
    const verified = (kind: 'pmtiles' | 'places'): RegionalPack[] =>
      packs
        .filter((p) => p.kind === kind && p.verified)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((p) => ({ id: p.id, path: p.path, region: regions.get(p.id) ?? null }));
    const placesPacks = verified('places');
    set({
      packs,
      archives,
      models,
      mapPacks: verified('pmtiles'),
      placesPacks,
      placesPaths: placesPacks.map((p) => p.path),
    });
  },
  adoptCatalog: async (source) => {
    const db = await appDb();
    const current = get().catalog;
    const chosen = await selectCatalog(db, [source], current?.trusted ?? []);
    const rejection = chosen.rejected[0] ?? null;
    if (!chosen.catalog || !chosen.accepted) return rejection;
    await writeAcceptedCatalog(chosen.accepted);
    set({ catalog: current ? { ...current, catalog: chosen.catalog, origin: 'update', sha256: chosen.sha256 } : null });
    // The new catalog may name the country of installed map and places packs.
    await get().refresh();
    return null;
  },
  bootstrap: async () => {
    if (get().status === 'loading' || get().status === 'ready') return;
    set({ status: 'loading', error: null });
    try {
      const db = await appDb();
      const [runtime, cpu, snapshot, simulateT1, allowMetered] = await Promise.all([
        ExpoZim.getRuntimeInfo(),
        ExpoDeviceProfile.getCpuInfo(),
        ExpoDeviceProfile.getSnapshot(),
        getSetting(db, 'dev.simulateT1'),
        getSetting(db, 'downloads.allowMetered'),
      ]);
      set({ runtime, cpu, totalRamMb: snapshot.totalRamMb, simulateT1: simulateT1 ?? false, allowMetered: allowMetered ?? false });
      const catalog = await loadCatalogState();
      set({ catalog });
      const reconcile = await contentStore.reconcile((file, hashed, total) => {
        set({ verifying: { file, percent: total > 0 ? Math.round((hashed / total) * 100) : 0 } });
      });
      set({ verifying: null, reconcile });
      await get().refresh();
      set({ status: 'ready' });
    } catch (e) {
      set({ status: 'error', verifying: null, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));

export function currentCatalog(): Catalog | null {
  return useContent.getState().catalog?.catalog ?? null;
}

/** Open archives with their ZIM language, for retrieval (language-aware fusion). */
export function ragArchives(): ArchiveRef[] {
  return useContent.getState().archives.map((a) => ({ archiveId: a.archiveId, language: a.language }));
}

export interface ActiveProfile {
  profile: InferenceProfile;
  model: InstalledModel | null;
}

function toActive(state: Pick<ContentState, 'cpu' | 'models' | 'totalRamMb' | 'simulateT1' | 'backend'>): ActiveProfile {
  const profile = resolveInferenceProfile({
    totalRamMb: state.totalRamMb,
    cpu: state.cpu,
    models: state.models,
    simulateT1: state.simulateT1,
    backend: state.backend,
  });
  return { profile, model: state.models.find((m) => m.id === profile.modelId) ?? null };
}

/** Inference profile for the current device and developer settings (outside React). */
export function activeProfile(): ActiveProfile {
  return toActive(useContent.getState());
}

/** Inference profile for the current device and developer settings. */
export function useActiveProfile(): ActiveProfile {
  const cpu = useContent((s) => s.cpu);
  const models = useContent((s) => s.models);
  const totalRamMb = useContent((s) => s.totalRamMb);
  const simulateT1 = useContent((s) => s.simulateT1);
  const backend = useContent((s) => s.backend);
  return toActive({ cpu, models, totalRamMb, simulateT1, backend });
}

/** Key for energy samples: costs differ per tier, and T1-simulation is measured on its own. */
export function energyTier(profile: InferenceProfile): string {
  return profile.mode === 't1-simulation' ? 't1-simulation' : profile.effectiveTier;
}

/** RAG settings that follow the active profile: character budget tier, tokenizer, context size. */
export function ragConfigFor(profile: InferenceProfile): Partial<RagConfig> {
  return { tier: profile.budgetTier, modelId: profile.modelId, contextSize: profile.load.contextSize };
}

/**
 * Loads the profile's model (no-op when already loaded) and prefills the fixed system prompt.
 * `onProgress` gets the load progress (0–1) for the UI.
 */
export async function ensureModel(
  active: ActiveProfile,
  onProgress?: (fraction: number) => void,
): Promise<{ loaded: LoadedModel; prewarmMs: number } | null> {
  if (!active.model) return null;
  const loaded = await llama.load(active.model, active.profile.load, onProgress);
  const prewarmMs = await llama.prewarm(SYSTEM_PROMPT);
  return { loaded, prewarmMs };
}
