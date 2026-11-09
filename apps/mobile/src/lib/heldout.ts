import { parseStructuredAnswer, retrieve, summarise, summaryAllowed, type RetrievalResult } from '@skepi/core';
import { ExpoZim } from 'expo-zim';
import { activeProfile, ensureModel, knowledge, llama, ragArchives, ragConfigFor } from './content';

/**
 * Held-out adversarial sets on the phone (the Android pipeline; developer Bench only): the same
 * `retrieve()` and `summarise()` as the Ask screen, with this device's profile and model, over the
 * installed packs plus the set's invented-article archive. Written by tools/rag-eval and pushed by
 * e2e/run-heldout.ps1; the results are judged by tools/rag-eval (`heldout-device`) with the same rules
 * as the desktop and eval runs. The AI summary runs for every answerable item (also medical ones, which
 * the Ask screen only summarises on request), so every shown sentence is checked.
 */
export const HELDOUT_RUN = 'heldout/run.json';
export const HELDOUT_OUTPUT = 'heldout/device.json';

interface HeldoutRun {
  schema: 1;
  set: string;
  /** Archive path relative to the content folder, e.g. heldout/eval-heldout-2.zim. */
  archive: string;
  items: { id: string; question: string }[];
}

function parseRun(text: string): HeldoutRun {
  const data = JSON.parse(text) as Partial<HeldoutRun>;
  if (data.schema !== 1 || typeof data.set !== 'string' || typeof data.archive !== 'string' || !Array.isArray(data.items)) {
    throw new Error(`${HELDOUT_RUN}: unexpected format`);
  }
  if (data.archive.split('/').includes('..')) throw new Error(`${HELDOUT_RUN}: archive must stay inside the content folder`);
  return data as HeldoutRun;
}

function sourcesOf(r: RetrievalResult): { id: string; title: string; heading: string; path: string; text: string }[] {
  return r.sources.map((s) => ({ id: s.id, title: s.title, heading: s.heading, path: s.path, text: s.text }));
}

/**
 * `consent(archive)` is asked before the set's archive opens: it is not in the signed catalog, so it
 * opens only by the user's explicit choice, like any unverified ZIM.
 */
export async function runHeldout(log: (line: string) => void, consent: (archive: string) => Promise<boolean>): Promise<number> {
  const raw = await ExpoZim.readContentFile(HELDOUT_RUN);
  if (raw === null) throw new Error(`${HELDOUT_RUN} not found (push it with e2e/run-heldout.ps1)`);
  const run = parseRun(raw);
  if (!(await consent(run.archive))) throw new Error(`held-out: ${run.archive} not opened (unverified, no consent)`);
  const { contentDir } = await ExpoZim.getRuntimeInfo();
  const extra = await ExpoZim.openArchive(`${contentDir}/${run.archive}`);
  const archives = [...ragArchives().filter((a) => a.archiveId !== extra.archiveId), { archiveId: extra.archiveId, language: extra.language }];
  const active = activeProfile();
  const config = ragConfigFor(active.profile);
  const ready = active.model ? await ensureModel(active) : null;
  const outcomes: unknown[] = [];
  for (const [i, item] of run.items.entries()) {
    const signal = new AbortController().signal;
    const r = await retrieve(item.question, knowledge, { signal, config, archives });
    let summary: unknown = null;
    // Same rule as the Ask screen: no AI summary on emergency intent.
    if (ready && summaryAllowed(r)) {
      const s = await summarise(r, llama, { signal, config });
      summary = {
        status: s.status,
        hiddenReason: s.hiddenReason,
        covered: parseStructuredAnswer(s.generation.text)?.covered ?? null,
        raw: s.generation.text,
        stopReason: s.generation.stopReason,
        sentences: (s.validation?.sentences ?? []).map((x) => ({ text: x.text, source: x.source, kept: x.kept, reason: x.reason, support: x.support })),
      };
    }
    outcomes.push({ id: item.id, retrieval: r.status, noSourceReason: r.noSourceReason, best: r.best, sources: sourcesOf(r), summary, layer1Ms: r.timings.layer1Ms });
    log(`held-out ${String(i + 1)}/${String(run.items.length)} ${item.id} ${r.status}`);
  }
  const report = {
    schema: 1,
    engine: 'android',
    createdAt: new Date().toISOString(),
    set: run.set,
    profile: { tier: active.profile.effectiveTier, budget: active.profile.budgetTier, model: active.profile.modelId, backend: active.profile.backend },
    archives: archives.map((a) => a.archiveId),
    outcomes,
  };
  const path = await ExpoZim.writeContentFile(HELDOUT_OUTPUT, JSON.stringify(report));
  log(`held-out: ${String(outcomes.length)} items written to ${path}`);
  return outcomes.length;
}
