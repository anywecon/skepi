import { packRegion, packTrust } from '@skepi/core';
import { useState } from 'react';
import { Banner, Button, errorText, formatBytes } from '../components/ui';
import { useMessages } from '../lib/i18n';
import { ipc, type CatalogPackJson, type DownloadProgressJson, type PackRow } from '../lib/ipc';
import { useApp } from '../lib/store';
import { MapsSection } from './Maps';

/**
 * Packs: the signed catalog, installed packs (integrity check, removal, consent for unverified ZIMs),
 * downloads (the app's only internet use, Rust downloader with per-chunk verification), file import
 * and the content folder (any drive; a USB stick makes the library portable).
 */
export function LibraryScreen() {
  const t = useMessages();
  const root = useApp((s) => s.root);
  const catalog = useApp((s) => s.catalog);
  const packs = useApp((s) => s.packs);
  const reconcile = useApp((s) => s.reconcile);
  const refresh = useApp((s) => s.refresh);
  const [progress, setProgress] = useState<Record<string, DownloadProgressJson>>({});
  const [message, setMessage] = useState<{ id: string; text: string; tone: 'danger' | 'info' } | null>(null);
  const [busy, setBusy] = useState(false);
  /** Unverified pack waiting for explicit consent (in-app dialog; WebView2 has no window.confirm here). */
  const [consenting, setConsenting] = useState<PackRow | null>(null);

  const cat = catalog?.catalog ?? null;
  const installed = new Set(packs.map((p) => p.id));
  // Country map and places packs are offered per country in Maps & places.
  const available = (cat?.packs ?? []).filter((p) => !installed.has(p.id) && packRegion(p) === null);

  const guard = async (id: string, work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    try {
      const text = await work();
      setMessage(text ? { id, text, tone: 'info' } : null);
    } catch (e) {
      setMessage({ id, text: errorText(e), tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  const download = (entry: CatalogPackJson): void => {
    setMessage(null);
    void ipc
      .contentDownload(entry.id, (p) => {
        setProgress((cur) => ({ ...cur, [entry.id]: p }));
      })
      .then(
        () => refresh(),
        (e: unknown) => {
          setMessage({ id: entry.id, text: t.library.failed(errorText(e)), tone: 'danger' });
        },
      );
  };

  const consent = async (p: PackRow): Promise<void> => {
    setConsenting(null);
    await guard(p.id, async () => {
      await ipc.contentConsent(p.id);
      await refresh();
      return null;
    });
  };

  return (
    <section className="stack" data-testid="library-screen">
      <h1>{t.tabs.library}</h1>

      <h2>{t.desktop.contentFolder}</h2>
      <div className="row">
        <code data-testid="content-root">{root}</code>
        <Button
          testId="choose-folder"
          tone="plain"
          label={t.desktop.chooseFolder}
          disabled={busy}
          onClick={() =>
            void guard('folder', async () => {
              const state = await ipc.contentChooseFolder();
              if (state) await refresh();
              return null;
            })
          }
        />
      </div>
      <p className="muted">{t.desktop.folderHint}</p>
      {reconcile && (
        <p className="muted" data-testid="reconcile-report">
          {t.desktop.reconciled({ registered: reconcile.registered.length, unverified: reconcile.unverified.length, missing: reconcile.missing.length })}
        </p>
      )}
      {reconcile && reconcile.rejectedModels.length > 0 && <Banner tone="warning">{t.library.rejectedModels(reconcile.rejectedModels.join(', '))}</Banner>}
      {reconcile && reconcile.rejectedMaps.length > 0 && <Banner tone="warning">{t.library.rejectedMaps(reconcile.rejectedMaps.join(', '))}</Banner>}

      <div className="row">
        <span data-testid="catalog-line">
          {cat ? t.library.catalog({ sequence: cat.sequence, keys: catalog?.purpose ?? '–', packs: cat.packs.length }) : t.library.noCatalog}
        </span>
        <Button
          testId="check-update"
          tone="plain"
          label={t.library.checkUpdate}
          disabled={busy}
          onClick={() =>
            void guard('catalog', async () => {
              const seq = await ipc.contentCheckUpdate();
              await refresh();
              return seq === null ? t.library.upToDate(cat?.sequence ?? 0) : t.library.updated(seq);
            }).catch(() => undefined)
          }
        />
        <Button
          testId="import-file"
          tone="plain"
          label={t.library.import}
          disabled={busy}
          onClick={() =>
            void guard('import', async () => {
              const row = await ipc.contentImport(() => undefined);
              await refresh();
              return row ? t.library.imported(row.title) : null;
            })
          }
        />
      </div>
      {catalog?.rejected.map((r) => (
        <Banner key={`${r.origin}-${r.reason}`} tone="warning">
          {t.library.catalogRejected({ origin: r.origin, reason: r.reason })}
        </Banner>
      ))}
      {message && (message.id === 'catalog' || message.id === 'import' || message.id === 'folder') && (
        <Banner tone={message.tone} testId="library-message">
          {message.text}
        </Banner>
      )}

      <MapsSection />

      <h2>{t.library.installed}</h2>
      {packs.length === 0 && <p className="muted">{t.library.none}</p>}
      {packs.map((p) => (
        <div key={p.id} className="card stack" data-testid={`installed-${p.id}`}>
          <strong>{p.title}</strong>
          <span className="muted">
            {p.kind} · {p.version} · {formatBytes(p.sizeBytes)} · {p.source}
            {p.license ? ` · ${t.library.licence(p.license)}` : ''}
          </span>
          {packTrust(cat, p) === 'unverified' ? (
            <span className="unverified">{t.unverified.label}</span>
          ) : (
            <span style={{ color: 'var(--ok)' }} data-testid={`trust-${p.id}`}>
              {packTrust(cat, p) === 'verified' ? t.library.verified : t.library.verifiedOlder}
            </span>
          )}
          <div className="row">
            {!p.verified && p.consentAt === null && (
              <Button
                testId={`consent-${p.id}`}
                tone="plain"
                label={t.library.open}
                onClick={() => {
                  setConsenting(p);
                }}
              />
            )}
            <Button
              testId={`verify-${p.id}`}
              tone="plain"
              label={t.library.verify}
              disabled={busy}
              onClick={() =>
                void guard(p.id, async () => {
                  const r = await ipc.contentVerify(p.id);
                  return r.ok ? t.library.verifyOk : t.library.verifyFailed;
                })
              }
            />
            <Button
              testId={`remove-${p.id}`}
              tone="danger"
              label={t.library.remove}
              disabled={busy}
              onClick={() =>
                void guard(p.id, async () => {
                  await ipc.contentRemove(p.id);
                  await refresh();
                  return null;
                })
              }
            />
          </div>
          {consenting?.id === p.id && (
            <div className="banner warning stack" role="alertdialog" data-testid="consent-dialog">
              <strong>{t.unverified.consentTitle}</strong>
              <span>{t.unverified.consentBody(p.title)}</span>
              <div className="row">
                <Button testId="consent-accept" tone="danger" label={t.unverified.consentAccept} onClick={() => void consent(p)} />
                <Button
                  testId="consent-cancel"
                  tone="plain"
                  label={t.unverified.cancel}
                  onClick={() => {
                    setConsenting(null);
                  }}
                />
              </div>
            </div>
          )}
          {message?.id === p.id && <Banner tone={message.tone}>{message.text}</Banner>}
        </div>
      ))}

      <h2>{t.library.available}</h2>
      {available.length === 0 && <p className="muted">{t.library.none}</p>}
      {available.map((entry) => {
        const pr = progress[entry.id];
        const running = pr !== undefined && (pr.phase === 'downloading' || pr.phase === 'verifying' || pr.phase === 'installing' || pr.phase === 'queued');
        const percent = pr && pr.totalBytes > 0 ? Math.floor((pr.bytes / pr.totalBytes) * 100) : 0;
        return (
          <div key={entry.id} className="card stack" data-testid={`available-${entry.id}`}>
            <strong>{entry.title.en}</strong>
            <span className="muted">
              {entry.kind} · {entry.version} · {t.library.size(formatBytes(entry.sizeBytes))} · {t.library.licence(entry.license)}
            </span>
            <div className="row">
              {!running && <Button testId={`download-${entry.id}`} label={t.library.download} onClick={() => { download(entry); }} />}
              {running && <Button testId={`cancel-${entry.id}`} tone="plain" label={t.library.cancel} onClick={() => void ipc.contentCancel(entry.id)} />}
            </div>
            {pr && (
              <div data-testid={`progress-${entry.id}`}>
                <span className="muted">
                  {t.library.progress({ phase: t.library.phase[pr.phase], percent, mirror: pr.mirror + 1, rejected: pr.rejectedMirrors })}
                </span>
                <div className="progress">
                  <div style={{ width: `${String(percent)}%` }} />
                </div>
              </div>
            )}
            {message?.id === entry.id && <Banner tone={message.tone}>{message.text}</Banner>}
          </div>
        );
      })}
    </section>
  );
}
