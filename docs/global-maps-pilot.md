# Global maps — pilot report (2026-10-23)

Owner decision 2026-10-23: the user picks a country, downloads its map and places packs, and uses them
offline. This report covers the pilot: the region and pack pipeline, the measured sizes, the eight pilot
countries built in CI, the app changes and the verification. **Nothing was uploaded or signed**: the
packs exist only in the CI runs (reports) and in the maintainer cache of this PC (Cyprus, Greece).
Design: [`architecture.md`](architecture.md) → "Offline maps" → "Global maps"; maintainer steps:
[`tools/catalog-builder/README.md`](../tools/catalog-builder/README.md) → "Country packs".

## Inputs (pinned)

| Input | Pin |
| --- | --- |
| Country boundaries | Natural Earth v5.1.2 `ne_10m_admin_0_countries` (SHA-256 `239eec57…f255`) and `ne_10m_admin_1_states_provinces` (`22d0e3ad…2fb5`), public domain |
| Basemap | Protomaps daily build `20261022` (basemap 4.15.2, 139.08 GB, MD5 `psbfbv+304fdON2I61p+Tg==`) |
| Places | Geofabrik extracts dated `261022` (publisher MD5 checked per file) |
| Tools | go-pmtiles 1.31.2 (Windows and Linux archives by SHA-256), pyosmium 4.3.1 / libosmium 2.23.1, shapely 2.2.0 (CI wheels by SHA-256), osmium-tool (Ubuntu 24.04 package, version in each report), Node 22 |

The Protomaps build of the first Greece pack (20261005) and its Geofabrik extract (`greece-261004`) were
already gone on 2026-10-23: inputs live about one to two weeks.

## Regions and the split rule

`make_regions.py` writes 239 regions (one per `ISO_A2_EH` code, plus the listed units without a code).
Dry runs (`pmtiles extract --dry-run`, build 20261022) of every region at z15:

- **Total 142.7 GB** for 239 countries (planet build 139.1 GB; the overlap of the 0.05° buffers adds ~3%).
- 116 countries ≤ 100 MB, 189 ≤ 500 MB, 220 ≤ 1.5 GB.
- Over 1.9 GB (GitHub's asset limit is 2 GB): US 17.0, CA 16.0, RU 13.0, FR 5.6, DE 5.5, CN 5.2, BR 4.3,
  IN 3.2, NO 3.0, PL 3.0, IT 2.7, GB 2.6, JP 2.6, SE 2.4, ES 2.3, AU 2.1, UA 2.0 GB; between 1.5 and
  1.9 GB: ID 1.9, FI 1.8.
- z14 is 44–52% of z15 for these countries (US 8.0, DE 2.6, IT 1.4, JP 1.2 GB), z13 about 25%.

**Rule:** ≤ 1.5 GB at z15 → one pack; larger → parts of neighbouring admin-1 subdivisions (Natural Earth
regions when each fits) by recursive bisection along the longer axis, each part measured ≤ 1.5 GB at z15;
a single subdivision over 1.5 GB → its own part at the highest zoom that fits. Lowering the max zoom for a
whole country was rejected: it would cost z15 detail for the most-used countries, while parts keep it and
let a user take only the region they need.

Pilot parts (measured, z15): Germany 6 (0.73–1.33 GB), Italy 2 (Lombardia… / Toscana…, 1.38–1.42 GB), Japan 3 (0.48–1.13 GB),
United States 16 (0.76–1.38 GB). Every part was built under 1.5 GB; the largest is 1.42 GB
(`map-it-lombardia`). The other pilot countries are one pack each (Greece 0.51, Cyprus 0.06, Portugal 0.58,
Turkey 1.30 GB).

## Pilot packs (CI, `.github/workflows/packs.yml`)

Run [40005452133](https://github.com/anywecon/skepi/actions/runs/40005452133) (commit `25314b8`), 39 jobs, all
green; 30 min wall time with GitHub's 20 concurrent jobs, 143 runner-minutes in total (setup included),
longest job `places-us` (27 min). Run [40000021978](https://github.com/anywecon/skepi/actions/runs/40000021978)
(commit `a4960c0`) built the same packs before the extract retry existed: 7 extracts there failed on
dropped range reads from the build server (now retried, three attempts).

| Country | Map | Map packs | Places | Places build | Places peak RAM | Places disk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Greece | 509.9 MB | 1 | 5.2 MB | 44 s | 2.2 GB | 0.35 GB |
| Cyprus | 55.9 MB | 1 | 0.5 MB | 7 s | 1.8 GB | 0.04 GB |
| Italy | 2.80 GB | 2 | 37.6 MB | 405 s | 2.1 GB | 2.32 GB |
| Germany | 5.98 GB | 6 | 43.9 MB | 709 s | 2.1 GB | 4.97 GB |
| Portugal | 584.8 MB | 1 | 6.4 MB | 41 s | 2.1 GB | 0.44 GB |
| Turkey | 1.30 GB | 1 | 17.2 MB | 82 s | 2.1 GB | 0.69 GB |
| United States | 17.85 GB | 16 | 63.6 MB | 1532 s | 2.2 GB | 12.37 GB |
| Japan | 2.65 GB | 3 | 47.7 MB | 255 s | 2.2 GB | 2.66 GB |
| **Pilot** | **31.74 GB** | **31** | **222 MB** | | | |

Map jobs: 7–35 s of extract each, peak RAM 128–454 MB, disk = the pack. Places jobs: the Geofabrik
download, `osmium tags-filter`, pyosmium + shapely and the SQLite build; disk = the extract + the pack.

Per pack (build s = `catalog pack`, job s = the timed step, RAM in MB, disk in GB, SHA-256 prefix):

| Pack | Country | Size | Build s | Job s | RAM MB | Disk GB | SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| map-cy | CY | 55.9 MB | 7 | 8 | 142 | 0.13 | `b756eac3fa73` |
| map-de-baden-wurttemberg | DE | 837.3 MB | 20 | 22 | 128 | 0.91 | `45d0383971fa` |
| map-de-bavaria | DE | 1290.3 MB | 25 | 26 | 132 | 1.37 | `e556a0d5f35e` |
| map-de-brandenburg | DE | 1333.4 MB | 28 | 29 | 133 | 1.41 | `1b2732279f3c` |
| map-de-hesse | DE | 801.9 MB | 20 | 21 | 131 | 0.88 | `b8f3d2016ba2` |
| map-de-lower-saxony | DE | 734.9 MB | 24 | 25 | 136 | 0.81 | `ae0ea7f7d29d` |
| map-de-north-rhine-westphalia | DE | 986.6 MB | 17 | 18 | 134 | 1.06 | `49345cfb5e4d` |
| map-gr | GR | 509.9 MB | 16 | 17 | 131 | 0.59 | `581af3a5640a` |
| map-it-lombardia | IT | 1422.4 MB | 24 | 26 | 134 | 1.50 | `e58b8f3a2c45` |
| map-it-toscana | IT | 1381.5 MB | 32 | 33 | 134 | 1.46 | `287d862e905c` |
| map-jp-chubu | JP | 1133.4 MB | 22 | 23 | 133 | 1.21 | `468f0a2025dd` |
| map-jp-kanto | JP | 480.3 MB | 11 | 12 | 134 | 0.56 | `d2f5790a32fe` |
| map-jp-kinki | JP | 1036.6 MB | 18 | 19 | 133 | 1.11 | `6d16df17547b` |
| map-pt | PT | 584.8 MB | 12 | 12 | 132 | 0.66 | `815bde018a94` |
| map-tr | TR | 1304.9 MB | 23 | 25 | 208 | 1.38 | `8f86c524de26` |
| map-us-alaska | US | 1166.9 MB | 32 | 33 | 454 | 1.24 | `5a180d45b68a` |
| map-us-arizona | US | 969.1 MB | 33 | 34 | 153 | 1.04 | `b3c5b6dad1aa` |
| map-us-california | US | 1304.6 MB | 16 | 17 | 130 | 1.38 | `8fc148b13b80` |
| map-us-colorado | US | 1121.0 MB | 34 | 35 | 262 | 1.20 | `414d9107d912` |
| map-us-florida | US | 1108.6 MB | 13 | 14 | 132 | 1.18 | `6fc9810b4b04` |
| map-us-georgia | US | 1384.1 MB | 33 | 34 | 134 | 1.46 | `1c8d7d0da16f` |
| map-us-illinois | US | 1247.9 MB | 25 | 26 | 146 | 1.32 | `1bb4d027a9fe` |
| map-us-kansas | US | 914.2 MB | 33 | 34 | 135 | 0.99 | `50933f108518` |
| map-us-massachusetts | US | 1127.5 MB | 19 | 21 | 131 | 1.20 | `1eb815f6a377` |
| map-us-minnesota | US | 1305.3 MB | 24 | 24 | 226 | 1.38 | `51ce88892155` |
| map-us-new-york | US | 1104.3 MB | 28 | 29 | 133 | 1.18 | `3d70a559bd33` |
| map-us-north-carolina | US | 759.3 MB | 14 | 15 | 128 | 0.83 | `ac5a5b15bc09` |
| map-us-ohio | US | 987.0 MB | 15 | 16 | 132 | 1.06 | `8476806e1663` |
| map-us-texas | US | 1258.3 MB | 25 | 26 | 220 | 1.33 | `1003c4ba4b36` |
| map-us-virginia | US | 993.8 MB | 21 | 22 | 131 | 1.07 | `718c2467ad47` |
| map-us-washington | US | 1094.3 MB | 24 | 25 | 244 | 1.17 | `9c2952b28478` |
| places-cy | CY | 0.5 MB | 7 | 7 | 1871 | 0.04 | `6d446cfd7963` |
| places-de | DE | 43.9 MB | 709 | 709 | 2200 | 4.97 | `37d870ca5f88` |
| places-gr | GR | 5.2 MB | 44 | 45 | 2225 | 0.35 | `d2f522d8b577` |
| places-it | IT | 37.6 MB | 405 | 405 | 2184 | 2.32 | `11377aff5101` |
| places-jp | JP | 47.7 MB | 255 | 255 | 2240 | 2.66 | `ee752191a450` |
| places-pt | PT | 6.4 MB | 41 | 41 | 2158 | 0.44 | `4a106f789f4e` |
| places-tr | TR | 17.2 MB | 82 | 82 | 2164 | 0.69 | `900f6f097590` |
| places-us | US | 63.6 MB | 1532 | 1533 | 2258 | 12.37 | `ee7092b61682` |

**Reproducibility.** The 37 packs that both runs built are byte-identical (same SHA-256). `map-cy`,
`places-cy`, `map-gr` and `places-gr` built on this Windows PC without the osmium pre-filter equal the CI
builds on Linux with it: the pre-filter changes nothing, and the build does not depend on the OS. The
places pack of Greece (36,925 places) is smaller than the published `places-gr-20261004` (37,262) because
objects outside the Natural Earth region are left out (533 candidates) and OSM changed in 18 days.

## Projection for every country

From the dry runs of all 239 regions (build 20261022) and the pilot's measured ratios:

| | Projection |
| --- | --- |
| Maps | ≈ 147 GB (142.7 GB at z15; parts add ≈ 5% for the 19 split countries: the pilot's split countries measured 30.25 GB as whole countries, 31.74 GB as packs) |
| Places | ≈ 1 GB (0.7% of the map size in the pilot) |
| Packs | ≈ 310 map packs (220 single, ≈ 90 parts of 19 countries) + 239 places packs ≈ 550 release assets (limit 1000, every asset < 1.5 GB) |
| CI | ≈ 550 jobs in 3 batches (≤ 256 per run), ≈ 30 runner-hours (3.5 min per job with setup), ≈ 2 h wall time per batch at 20 parallel jobs; the largest places jobs (Russia, Canada, United States) fit the runner's `/mnt` disk (117 GB free measured; the United States used 12.4 GB) |
| Maintainer | ≈ 148 GB to download once for `prepare --reports`, then the offline signature |

## App

- Packs → "Maps & places" (Android, iOS, Windows/macOS): country search, sizes, free-space rule for the
  whole country, T0/T1 warning (≥ 1 GB, or < 4 GB left), download on the user's press only, update,
  delete, parts of split countries, "Use for emergency numbers".
- One map with every installed country (one vector source per pack), places search and the emergency
  POI layer over every installed country (each OSM object once), emergency number of the country of the
  live position (installed countries only, memory only).
- Catalog schema 2 (`region` on map and places packs) in TypeScript and Rust; schema 1 catalogs (Greece)
  keep working; installed `map-gr` / `places-gr` become updatable by id.
- P2P: country packs are ordinary catalog packs (unit-tested propagation of a schema 2 host catalog).

## Verification

| Check | Result |
| --- | --- |
| Typecheck, lint, unit tests | `pnpm verify` 49/49 tasks (core 423 tests incl. catalog schema 2, regions, multi-source style, storage, P2P of country packs, onboarding migration; catalog-builder 45 incl. countries manifest, schema 2 build, osmium filter = `candidate()`, CI report comparison); `catalog check-fixtures` OK |
| Rust | `cargo fmt`, `cargo clippy -D warnings`, `cargo test -p desktop-core` (schema 2 parity with catalog.ts) |
| Android release build | `assembleRelease -PskepiUnsigned=true -PskepiPreview=true`: cards gate 111/111 sourced, 0/199 unsourced; permission allowlist PASS (no new permission); arm64 APK 50.7 MB |
| Desktop release build | `tauri build`: MSI 38.5 MiB, NSIS 22.4 MiB; Playwright 16/16 (new: Maps & places search, download, use for numbers, delete, Greece update) |
| Maestro on the S23 | `e2e/run-countries-e2e.ps1` (device lock, debug build, schema 2 test catalog sequence 5 signed with the test key): Cyprus and Greece downloaded from the local mirror, then airplane mode: Nicosia and Patras in the home search, the map with both packs and emergency points in each country (8 in central Nicosia), Cyprus deleted (its places gone, Greece left): **PASS**, 6 download requests all to the mirror, 0 bytes over real interfaces |
| CI | run [40000021067](https://github.com/anywecon/skepi/actions/runs/40000021067) (workflow_dispatch on `feat/global-maps`): verify, rag-eval smoke, Android release guards, desktop Windows and macOS, **ios-build and ios-e2e** green |

## Review fixes (2026-10-24)

- **Parts**: a split country's parts are listed by name (from their admin-1 regions), with size, a
  per-part download and delete, and "Download all parts"; a subdivision ("Bayern", "Tokyo") finds the
  country and marks the part. Map home, places and search work with any subset of parts; the country's
  places pack goes with its last part. A catalog that lists only some parts still shows them as parts
  (`isSplit` by part, found by the S23 run below). `catalog countries --parts JP:kanto` builds test catalogs.
- **Catalog updates of v0.1.x**: release builds 0.1.0–0.1.2 have no catalog update source and never
  fetch one (Android `sourcesFile` empty, iOS without `sources.json`, desktop `SOURCES = None`), so no
  schema-1 path is needed; recorded in `docs/architecture.md`.
- **Emergency numbers**: Japan (110 NPA, 119 FDMA, 118 JCG) and Türkiye (112) with official sources,
  snapshots and retrieval date, checked by `cards-source-check` like the card sources and pinned by
  `numbersDigest` in every release build.
- **Hosting**: pack generation retention (newest in full; older ones only the assets the last two app
  releases embed), assets and size per release, worst case ≈ 444 GB: `tools/catalog-builder/README.md`
  step 6 and `docs/architecture.md`.

| Check | Result |
| --- | --- |
| Unit, typecheck, lint | `pnpm verify` 49/49; Rust fmt/clippy/test |
| Release builds | Android `assembleRelease` (cards 111/111, permission allowlist PASS); `tauri build` MSI + NSIS; Playwright 17/17 (one German part found by "Bayern", all parts, delete part) |
| Maestro on the S23 | `run-countries-e2e.ps1` (device lock): Cyprus, Greece and Japan's Kanto part only (found by "Tokyo") from the local mirror; offline Yokohama in search, map and POIs; delete Cyprus, then the Kanto part (Japan's places go with it): **PASS**, 8 requests all to the mirror, 0 bytes over real interfaces. First run failed: Japan with one listed part showed as a whole country; fixed (`isSplit`). |
| CI | run [40078020534](https://github.com/anywecon/skepi/actions/runs/40078020534) (with the `isSplit` fix) green: verify, rag-eval smoke, Android release guards, desktop Windows and macOS, ios-build, ios-e2e |

## Open

- **Owner**: upload and sign (steps in `tools/catalog-builder/README.md` → "Country packs"); the
  pinned inputs (Protomaps 20261022, Geofabrik 261022) expire in about two weeks, so either publish this
  pilot's packs (`upload_packs`) soon or re-pin a new date for the full run.
- Emergency numbers: 35 of 239 countries have source-checked numbers (Japan and Türkiye added
  2026-10-24); the rest keep 112 with "check the local number" until an official national source is
  snapshotted (plan in `docs/architecture.md` → Emergency numbers). AU and CA sources block automated
  checks (listed as unchecked).
- A schema 2 catalog reaches only apps with this change: ship it embedded in the next app release.
- The map with many countries (71 layers per pack) is measured on the S23 with two countries only;
  T1 phones and five or more countries are not measured.
- iOS: Maps & places compiles and its logic is unit-tested; downloads are not supported on iOS yet
  (Phase 3b-0), so the iOS E2E still uses provisioned packs.
