import { parseManifest } from '@skepi/core';
import { expect, test, type Page } from '@playwright/test';

/**
 * Desktop UI flows against the mocked native commands (src/lib/mock.ts): search, sealed viewer
 * requests, Layer 1 + AI summary with verified citations, medical and emergency rules (no AI summary), IFRC
 * cards with their citation, map with POIs, Library downloads/consent, Station mode, external links as text.
 */

interface Recorded {
  calls: { command: string; args: Record<string, unknown> }[];
  viewer: { archiveId: string; path: string; anchor: string | null }[];
  station: { manifest: string; packIds: string[] } | null;
  report: string | null;
}

/** The part of MapLibre's Map these tests use (`__skepiMap`, e2e mode only). */
interface MapGl {
  getLayer: (id: string) => unknown;
  getSource: (id: string) => unknown;
  queryRenderedFeatures: (o: { layers: string[] }) => { geometry: { coordinates: number[] } }[];
  project: (c: [number, number]) => { x: number; y: number };
}

async function record(page: Page): Promise<Recorded> {
  return page.evaluate(() => {
    const m = (window as unknown as { __skepiMock: Recorded }).__skepiMock;
    return { calls: m.calls, viewer: m.viewer, station: m.station, report: m.report };
  });
}

test.beforeEach(async ({ page }) => {
  // Zero egress from the UI: any request outside the dev server fails the test.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:1420).*/, (route) => route.abort());
  await page.goto('/');
  await expect(page.getByTestId('search-screen')).toBeVisible();
});

test('search: suggestions, full-text, cards and places; articles open in the sealed viewer', async ({ page }) => {
  await page.getByTestId('search-input').fill('canber');
  await page.getByTestId('hit-Canberra').click();
  await expect.poll(async () => (await record(page)).viewer.at(-1)?.path).toBe('Canberra');

  await page.getByTestId('search-input').fill('capital');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('hit-Canberra')).toBeVisible();
  await expect(page.getByTestId('search-timing')).toContainText('fulltext');

  await page.getByTestId('search-input').fill('bleeding');
  await expect(page.getByTestId('card-link-bleeding')).toBeVisible();

  await page.getByTestId('search-input').fill('patras');
  await page.getByTestId('place-1').click();
  await expect(page.getByTestId('map-screen')).toBeVisible();
  await expect(page.getByTestId('map-focus')).toHaveText('Patras');
});

test('ask: Layer 1 then the AI summary with a verified citation (T3, automatic)', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('What is the capital of Australia?');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('layer1')).toBeVisible();
  await expect(page.getByTestId('layer1')).toContainText('Source excerpts — not verified advice');
  await expect(page.getByTestId('layer1-source-S1')).toContainText('Canberra');
  await expect(page.getByTestId('ai-label')).toHaveText('AI summary — check the source');
  await expect(page.getByTestId('answer-sentence-0')).toContainText('Canberra is the capital city of Australia.');
  await page.getByTestId('citation-S1').click();
  await expect.poll(async () => (await record(page)).viewer.at(-1)?.path).toBe('Canberra');
  await expect(page.getByTestId('ask-metrics')).toContainText('tier=T3');
  const calls = (await record(page)).calls.map((c) => c.command);
  expect(calls).toContain('llm_load');
  expect(calls).toContain('llm_generate');
});

test('ask: no source means no generation', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('lattice chromodynamics gluon');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('no-source')).toBeVisible();
  expect((await record(page)).calls.some((c) => c.command === 'llm_generate' && (c.args.request as { maxTokens: number }).maxTokens > 1)).toBe(false);
});

test('ask: medical intent shows the number and Layer 1 only, never an AI summary', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('How long should I boil water to kill disease?');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('layer1')).toBeVisible();
  await expect(page.getByTestId('medical-notice')).toBeVisible();
  await expect(page.getByTestId('summary-medical')).toHaveText('AI summaries are not available for medical questions.');
  await expect(page.getByTestId('ai-summary')).toHaveCount(0);
  await expect(page.getByTestId('ask-summarise')).toHaveCount(0);
  expect((await record(page)).calls.some((c) => c.command === 'llm_generate' && (c.args.request as { maxTokens: number }).maxTokens > 1)).toBe(false);
});

test('emergency: numbers and cards (IFRC, Ready.gov) without any pack', async ({ page }) => {
  await page.getByTestId('emergency-button').click();
  await expect(page.getByTestId('emergency-numbers')).toContainText('112');
  await page.getByTestId('card-open-cpr').click();
  await expect(page.getByTestId('card-call-first')).toHaveText('Call 112 first');
  await expect(page.getByTestId('card-step-5')).toContainText('Begin chest compressions without delay');
  await expect(page.getByTestId('card-citation')).toContainText('IFRC International First Aid, Resuscitation and Education Guidelines 2025');
  await expect(page.getByTestId('card-citation')).toContainText('pp. 161–162');
  await expect(page.getByTestId('card-disclaimer')).toHaveCount(0);
  await page.getByTestId('cards-back').click();
  await page.getByTestId('card-open-flood').click();
  await expect(page.getByTestId('card-call-first')).toHaveText('Call 112 first');
  await expect(page.getByTestId('card-step-1')).toHaveText('Find safe shelter right away.');
  await expect(page.getByTestId('card-citation')).toHaveText('Source: FEMA, Ready.gov. “Floods”, https://www.ready.gov/floods, retrieved 2026-10-21.');
  await expect(page.getByTestId('card-disclaimer')).toContainText('does not imply that the Federal Emergency Management Agency or the U.S. Government endorses S.K.E.P.I.');
});

test('map: offline PMTiles through the maps protocol, emergency POIs and filters', async ({ page }) => {
  await page.getByTestId('tab-map').click();
  await expect(page.getByTestId('map-status')).toContainText('offline PMTiles', { timeout: 30_000 });
  // Global maps: the map opens on the whole country (Greece, schema 2 region), too far out for POIs.
  await expect(page.getByTestId('poi-count')).toContainText('Zoom in to see emergency points');
  await page.evaluate(() => {
    (window as unknown as { __skepiMap: { jumpTo: (o: { center: [number, number]; zoom: number }) => void } }).__skepiMap.jumpTo({ center: [21.7346, 38.2466], zoom: 12 });
  });
  await expect(page.getByTestId('poi-count')).toContainText('2 emergency points');
  // The app's own layer is drawn, separate from the base style's `pois` symbols, and a circle can be clicked.
  const drawn = (): Promise<{ layer: boolean; source: boolean; rendered: number }> =>
    page.evaluate(() => {
      const m = (window as unknown as { __skepiMap: MapGl }).__skepiMap;
      return { layer: Boolean(m.getLayer('skepi-pois')), source: Boolean(m.getSource('skepi-pois')), rendered: m.queryRenderedFeatures({ layers: ['skepi-pois'] }).length };
    });
  await expect.poll(drawn, { timeout: 15_000 }).toEqual({ layer: true, source: true, rendered: 2 });
  const at = await page.evaluate(() => {
    const m = (window as unknown as { __skepiMap: MapGl }).__skepiMap;
    const [lon, lat] = m.queryRenderedFeatures({ layers: ['skepi-pois'] })[0]?.geometry.coordinates ?? [0, 0];
    return m.project([lon ?? 0, lat ?? 0]);
  });
  await page.getByTestId('map').click({ position: { x: at.x, y: at.y } });
  await expect(page.getByTestId('poi-selected')).toBeVisible();
  await page.getByTestId('poi-filter-hospital').uncheck();
  await expect(page.getByTestId('map-attribution')).toContainText('OpenStreetMap');
});

test('library: download with progress, consent for an unverified pack, catalog update', async ({ page }) => {
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('catalog-line')).toContainText('Signed catalog 3');
  await page.getByTestId('download-wikipedia_en_medicine_mini').click();
  await expect(page.getByTestId('installed-wikipedia_en_medicine_mini')).toBeVisible();
  await page.getByTestId('consent-local-0123456789ab').click();
  await expect(page.getByTestId('consent-dialog')).toContainText('does not match any signed catalog entry');
  await page.getByTestId('consent-accept').click();
  await expect(page.getByTestId('consent-local-0123456789ab')).toHaveCount(0);
  await page.getByTestId('check-update').click();
  await expect(page.getByTestId('library-message')).toContainText('Catalog updated to 4');
});

test('maps & places: search countries, download one, update Greece, delete', async ({ page }) => {
  await page.getByTestId('tab-library').click();
  await expect(page.getByTestId('maps-section')).toBeVisible();
  // Country packs are listed per country, not in the generic list.
  await expect(page.getByTestId('available-map-cy')).toHaveCount(0);
  await expect(page.getByTestId('country-status-GR')).toContainText('Update available');
  await page.getByTestId('maps-search').fill('cypr');
  await expect(page.getByTestId('country-GR')).toHaveCount(0);
  await expect(page.getByTestId('country-status-CY')).toContainText('Not installed');
  await page.getByTestId('country-download-CY').click();
  await expect(page.getByTestId('country-status-CY')).toContainText('Installed');
  await expect(page.getByTestId('installed-map-cy')).toBeVisible();
  await expect(page.getByTestId('installed-places-cy')).toBeVisible();
  await page.getByTestId('country-select-CY').click();
  await expect(page.getByTestId('country-selected-CY')).toBeVisible();
  await page.getByTestId('country-delete-CY').click();
  await page.getByTestId('remove-accept').click();
  await expect(page.getByTestId('country-status-CY')).toContainText('Not installed');
  await expect(page.getByTestId('installed-map-cy')).toHaveCount(0);
  await page.getByTestId('maps-search').fill('greece');
  await page.getByTestId('country-download-GR').click();
  await expect(page.getByTestId('country-status-GR')).toContainText('Installed');
});

test('maps & places: one part of a split country found by a subdivision, all parts, delete the part', async ({ page }) => {
  await page.getByTestId('tab-library').click();
  await page.getByTestId('maps-search').fill('Bayern');
  await expect(page.getByTestId('country-DE')).toBeVisible();
  await expect(page.getByTestId('country-CY')).toHaveCount(0);
  await expect(page.getByTestId('country-part-match-map-de-bavaria')).toContainText('Includes Bayern');
  await expect(page.getByTestId('country-part-match-map-de-hesse')).toHaveCount(0);
  await expect(page.getByTestId('country-part-row-map-de-bavaria')).toContainText('Bavaria, Thuringia');
  await expect(page.getByTestId('country-download-DE')).toContainText('Download all parts');
  // One part: its map and the country's places, nothing else.
  await page.getByTestId('country-part-map-de-bavaria').click();
  await expect(page.getByTestId('country-status-DE')).toContainText('Partly installed');
  await expect(page.getByTestId('installed-map-de-bavaria')).toBeVisible();
  await expect(page.getByTestId('installed-places-de')).toBeVisible();
  await expect(page.getByTestId('installed-map-de-hesse')).toHaveCount(0);
  await expect(page.getByTestId('country-download-DE')).toContainText('Download all parts (802.0 MB)');
  // Deleting the last part takes the places with it.
  await page.getByTestId('country-part-delete-map-de-bavaria').click();
  await expect(page.getByTestId('remove-dialog')).toContainText('last part');
  await page.getByTestId('remove-accept').click();
  await expect(page.getByTestId('country-status-DE')).toContainText('Not installed');
  await expect(page.getByTestId('installed-places-de')).toHaveCount(0);
});

test('station: only the selected packs in the manifest, QR pairing, stop', async ({ page }) => {
  await page.getByTestId('tab-station').click();
  await expect(page.getByTestId('firewall-note')).toContainText('private networks');
  await page.getByTestId('station-pack-test-smoke-en').check();
  await page.getByTestId('station-start').click();
  await expect(page.getByTestId('station-qr')).toBeVisible();
  await expect(page.getByTestId('station-code')).toContainText('"certSha256"');
  const station = (await record(page)).station;
  expect(station?.packIds).toEqual(['test-smoke-en']);
  const manifest = parseManifest(station?.manifest ?? '');
  expect(manifest.packs.map((p) => p.id)).toEqual(['test-smoke-en']);
  await page.getByTestId('station-stop').click();
  await expect(page.getByTestId('station-start')).toBeVisible();
});

test('viewer external links are shown as text, never opened', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as { __skepiMock: { emit: (e: string, p: string) => void } }).__skepiMock.emit('viewer-external', 'https://example.invalid/');
  });
  await expect(page.getByTestId('external-links')).toContainText('External link (not opened): https://example.invalid/');
});

test('settings: blackout theme and AI power cap off (library only)', async ({ page }) => {
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('device-line')).toContainText('tier T3');
  await page.getByTestId('blackout-toggle').check();
  await expect(page.locator('.app')).toHaveAttribute('data-theme', 'blackout');
  await page.getByTestId('power-cap-off').check();
  await page.getByTestId('tab-ask').click();
  await expect(page.getByText('No GGUF model found: source search only.')).toBeVisible();
});

test('report a problem: question, shown answer, sources and version only; copy and save, nothing sent', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('What is the capital of Australia?');
  await page.getByTestId('ask-submit').click();
  await expect(page.getByTestId('answer-sentence-0')).toBeVisible();
  await page.getByTestId('ask-report').click();
  const text = await page.getByTestId('report-text').inputValue();
  expect(text).toContain('What is the capital of Australia?');
  expect(text).toContain('Canberra is the capital city of Australia. [S1]');
  expect(text).toMatch(/App version: S\.K\.E\.P\.I\. \d+\.\d+\.\d+(-preview)? \(Windows\)/);
  // AI Act Art. 50: copied or saved text with an AI summary carries the plain marker line.
  expect(text.split('\n')).toContain('AI-generated summary');
  expect(text).toContain('Cited sources:');
  expect(text).not.toMatch(/archive|\d{4}-\d{2}-\d{2}|tier=|gpu/i);
  await page.getByTestId('report-copy').click();
  await expect(page.getByTestId('report-status')).toHaveText('Copied');
  // The Windows clipboard returns CRLF line breaks.
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')).toBe(text);
  await page.getByTestId('report-save').click();
  await expect(page.getByTestId('report-status')).toContainText('Saved: ');
  expect((await record(page)).report).toBe(text);
  const commands = (await record(page)).calls.map((c) => c.command);
  expect(commands.filter((c) => c.startsWith('content_download') || c.startsWith('content_check_update'))).toEqual([]);
});

test('about: licence, content licences, signing, privacy and the generated third-party notices', async ({ page }) => {
  await page.getByTestId('tab-about').click();
  await expect(page.getByTestId('about-licence')).toContainText('GPL-3.0-or-later');
  await expect(page.getByTestId('about-content')).toContainText('CC BY-SA 4.0');
  await expect(page.getByTestId('about-content')).toContainText('ODbL');
  await expect(page.getByTestId('about-content')).toContainText('Apache License 2.0');
  await expect(page.getByTestId('about-signing')).toContainText('7d61c38241b178f84b12dd9a67af6b60b56159b1a0ff067fe672db45dd45447e');
  await expect(page.getByTestId('about-privacy')).toContainText('no accounts, analytics, ads or telemetry');
  await expect(page.getByTestId('about-notices')).toContainText(/\d+ components: \d+ JavaScript, \d+ Rust/);
  await page.getByTestId('about-notices-toggle').click();
  await page.getByTestId('about-notices-filter').fill('tauri');
  await expect(page.getByTestId('about-notices-list').locator('li').first()).toContainText('tauri');
});

test('emergency question: the country number is shown before any Layer 1 excerpt', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('Earthquake shaking: what is an earthquake?');
  await page.getByTestId('ask-submit').click();
  // At the moment Layer 1 first appears, the number banner is already there and above it.
  const order = await page.waitForFunction(() => {
    const layer1 = document.querySelector('[data-testid="layer1"]');
    if (!layer1) return null;
    const banner = document.querySelector('[data-testid="emergency-banner"]');
    return { banner: banner?.textContent ?? null, before: banner ? Boolean(banner.compareDocumentPosition(layer1) & Node.DOCUMENT_POSITION_FOLLOWING) : false };
  });
  const v = (await order.jsonValue()) as { banner: string | null; before: boolean };
  expect(v.banner).toContain('Call 112');
  expect(v.before).toBe(true);
  // Emergency intent: no AI summary at all, not even on demand.
  await expect(page.getByTestId('summary-emergency')).toBeVisible();
  await expect(page.getByTestId('ask-summarise')).toHaveCount(0);
  await expect(page.getByTestId('ai-summary')).toHaveCount(0);
});

test('emergency question: a phone number in a source excerpt is flagged, addresses are removed', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('Earthquake shaking: what is an earthquake?');
  await page.getByTestId('ask-submit').click();
  const passage = page.getByTestId('layer1-passage-0');
  await expect(passage).toContainText('555-0177');
  await expect(passage).toContainText('[link removed]');
  await expect(passage).not.toContainText('quakes@desk.example');
  await expect(page.getByTestId('layer1-number-flag-0')).toHaveText('⚠ Number from a source — use the emergency number shown above');
});

test('no emergency intent: the same number is not flagged, the address is still removed', async ({ page }) => {
  await page.getByTestId('tab-ask').click();
  await page.getByTestId('ask-input').fill('Who takes reports about the shaking surface of the Earth?');
  await page.getByTestId('ask-submit').click();
  await page.getByTestId('layer1-toggle-0').click();
  const passage = page.getByTestId('layer1-passage-0');
  await expect(passage).toContainText('555-0177');
  await expect(passage).toContainText('[link removed]');
  await expect(page.getByTestId('emergency-banner')).toHaveCount(0);
  await expect(page.getByTestId('layer1-number-flag-0')).toHaveCount(0);
});
