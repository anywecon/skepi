# Contributing to SKEPI

Thank you for helping. SKEPI is a Developer Preview: issues, tests on other devices and focused pull
requests are all useful.

## Before you start

- Read [`docs/architecture.md`](docs/architecture.md) (the source of truth) and
  [`docs/threat-model.md`](docs/threat-model.md). Security problems go to [SECURITY.md](SECURITY.md),
  never to a public issue.
- English only until v1 (code, comments, commits, UI strings; the Greek locale is frozen).
- Problems with an answer: use "Report a problem with this answer" in the app, copy the text into an
  issue and add what you expected. The text contains only the question, what was shown, the cited
  sources and the app version.

## Ground rules

- **Non-commercial, always** (owner decision 2026-10-21). No paid features, ads, analytics or data
  collection, and no feature or service in exchange for money. Donations are welcome only without
  consideration: nothing (features, support, priority) is given in return. This keeps S.K.E.P.I. outside
  a commercial activity under the Product Liability Directive (EU) 2024/2853 and the Cyber Resilience Act
  (EU) 2024/2847, and within the IFRC's non-commercial licence for the card text. A pull request that adds
  any of the above is not merged.
- **Offline first.** No analytics, telemetry, ads or remote calls. Network code lives only in the
  ContentStore (downloads) and the local P2P / Station modules; ESLint enforces it in the apps.
- **Emergency cards** are verbatim excerpts from the IFRC International First Aid, Resuscitation and
  Education Guidelines, each step with its section and printed page. No paraphrase, no merged
  excerpts, no AI-written text. After any change run `tools/cards-source-check` with `--write-lock`
  (needs `pdftotext` from Poppler or Xpdf) and commit `packages/emergency-cards/source-check.lock.json`;
  CI repeats the check against the pinned PDF. A topic without an IFRC passage is not shipped.
- **No AI summary on medical or emergency questions** (cards and source excerpts only), and every AI
  summary keeps its visible label; text shared out of the app with an AI summary carries
  "AI-generated summary".
- **AI safety rules are not tuned against held-out sets.** The rag-eval held-out adversarial sets are
  report-only; prompts, the sanitizer, lexicons and thresholds change only by an explicit maintainer
  decision recorded in the phase report (see `tools/rag-eval/README.md`).
- Dependencies: pinned versions; native artefacts pinned by SHA-256 (`native/*`, `scripts/content.lock.json`).
  npm versions must be at least 7 days old (`minimumReleaseAge` in `pnpm-workspace.yaml`); exceptions
  only by the maintainer's decision, by exact version (`docs/release-process.md`, §4 "Dependency release age").
- TypeScript strict, no `any`; Rust with `clippy -D warnings`; conventional commits in English.

## Checks

```sh
pnpm install
pnpm verify                       # typecheck + lint + unit tests
cargo fmt --all -- --check        # desktop crates (on Windows through scripts/with-msvc.ps1)
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Answer quality: `pnpm --filter @skepi/rag-eval eval` (full, needs the provisioned packs and model) or
`--smoke`. Android E2E: `e2e/run-e2e.ps1` (Maestro, airplane mode). Desktop: `pnpm --filter
@skepi/desktop e2e` (Playwright, mocked native side) and `apps/desktop/e2e/tauri-smoke.mjs` (real build).
A pull request should keep CI green and say which device it was tested on.

## Licence

By contributing you agree that your contribution is licensed under GPL-3.0-or-later. Emergency-card
text is not ours: it is quoted from the IFRC guidelines under their terms ("Copies of all or part of this
study may be made for non-commercial use, providing the source is acknowledged.").
