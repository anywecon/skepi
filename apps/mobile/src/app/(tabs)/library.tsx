import type { InstalledPack } from '@skepi/contracts';
import { packRegion, type CatalogPack } from '@skepi/core';
import { getDocumentAsync } from 'expo-document-picker';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { Button, useStyles } from '../../components/ui';
import { contentStore, useContent } from '../../lib/content';
import { ContentError, fetchCatalogUpdate } from '../../lib/contentStore';
import { formatBytes, useDownloads } from '../../lib/downloads';
import { useLanguage, useMessages } from '../../lib/i18n';
import { usePrefs } from '../../lib/prefs';

function confirm(title: string, body: string, accept: string, cancel: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: cancel, style: 'cancel', onPress: () => { resolve(false); } },
      { text: accept, onPress: () => { resolve(true); } },
    ]);
  });
}

export default function LibraryScreen() {
  const styles = useStyles();
  const router = useRouter();
  const restartOnboarding = usePrefs((s) => s.restartOnboarding);
  const t = useMessages();
  const lang = useLanguage();
  const status = useContent((s) => s.status);
  const catalogState = useContent((s) => s.catalog);
  const packs = useContent((s) => s.packs);
  const reconcile = useContent((s) => s.reconcile);
  const refresh = useContent((s) => s.refresh);
  const adoptCatalog = useContent((s) => s.adoptCatalog);
  const allowMetered = useContent((s) => s.allowMetered);
  const setAllowMetered = useContent((s) => s.setAllowMetered);
  const downloads = useDownloads((s) => s.byPack);
  const startDownload = useDownloads((s) => s.start);
  const cancelDownload = useDownloads((s) => s.cancel);
  const resumeActive = useDownloads((s) => s.resumeActive);
  const [message, setMessage] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [networkLog, setNetworkLog] = useState(contentStore.networkLog());

  useEffect(() => {
    if (status === 'ready') void resumeActive();
  }, [status, resumeActive]);

  // The network log only changes when a download starts; refresh it with the download states.
  useEffect(() => {
    setNetworkLog(contentStore.networkLog());
  }, [downloads]);

  const catalog = catalogState?.catalog ?? null;
  const installedIds = new Set(packs.map((p) => p.id));
  // Country map and places packs are offered per country in Maps & places.
  const available = (catalog?.packs ?? []).filter((p) => !installedIds.has(p.id) && packRegion(p) === null);

  const download = async (entry: CatalogPack): Promise<void> => {
    const space = contentStore.freeSpace(entry.sizeBytes);
    if (!space.ok) {
      setMessage({ id: entry.id, text: t.library.noSpace({ needed: formatBytes(space.requiredBytes), free: formatBytes(space.freeBytes) }) });
      return;
    }
    const net = contentStore.networkState();
    let metered = allowMetered;
    if (net.metered) {
      // On a metered network the size is shown and the user decides (architecture: Wi-Fi only by default).
      metered = await confirm(t.library.meteredTitle, t.library.meteredBody(formatBytes(entry.sizeBytes)), t.library.meteredAccept, t.library.cancel);
      if (!metered) return;
    }
    setMessage(null);
    startDownload(entry, metered);
  };

  const consent = async (pack: InstalledPack): Promise<void> => {
    const ok = await confirm(t.unverified.consentTitle, t.unverified.consentBody(pack.title), t.unverified.consentAccept, t.unverified.cancel);
    if (!ok) return;
    await contentStore.consent(pack.id);
    await refresh();
  };

  const importFile = async (): Promise<void> => {
    const picked = await getDocumentAsync({ type: '*/*', copyToCacheDirectory: false, multiple: false });
    const asset = picked.canceled ? null : picked.assets[0];
    if (!asset) return;
    setBusy(true);
    setMessage({ id: 'import', text: t.library.importing });
    try {
      const pack = await contentStore.importFile(asset.uri);
      await refresh();
      setMessage({ id: 'import', text: t.library.imported(pack.title) });
      if (!pack.verified) await consent(pack);
    } catch (e) {
      const reason = e instanceof ContentError ? e.message : e instanceof Error ? e.message : String(e);
      setMessage({ id: 'import', text: t.library.importRejected(reason) });
    } finally {
      setBusy(false);
    }
  };

  const verify = async (pack: InstalledPack): Promise<void> => {
    setBusy(true);
    try {
      const r = await contentStore.verify(pack);
      setMessage({ id: pack.id, text: r.ok ? t.library.verifyOk : t.library.verifyFailed });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (pack: InstalledPack): Promise<void> => {
    setBusy(true);
    try {
      await contentStore.remove(pack.id);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const checkUpdate = async (): Promise<void> => {
    const url = catalogState?.updateUrls[0];
    if (!url) return;
    setBusy(true);
    try {
      const before = catalog?.sequence ?? 0;
      const candidate = await fetchCatalogUpdate(url, new AbortController().signal);
      const rejection = await adoptCatalog(candidate);
      const after = useContent.getState().catalog?.catalog?.sequence ?? before;
      setMessage({
        id: 'catalog',
        text: rejection ? t.library.updateRejected(`${rejection.reason}: ${rejection.detail}`) : after > before ? t.library.updated(after) : t.library.upToDate(after),
      });
    } catch (e) {
      setMessage({ id: 'catalog', text: t.library.updateRejected(e instanceof Error ? e.message : String(e)) });
    } finally {
      setBusy(false);
      setNetworkLog(contentStore.networkLog());
    }
  };

  const note = (id: string): React.ReactNode =>
    message?.id === id ? (
      <Text style={styles.muted} testID={`message-${id}`}>
        {message.text}
      </Text>
    ) : null;

  const title = (p: { title: { en: string; el?: string } }): string => (lang === 'el' ? (p.title.el ?? p.title.en) : p.title.en);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={{ gap: 12, paddingBottom: 48 }} testID="library">
      {/* Nearby sharing first: in a crisis this is how packs and the app reach other phones. */}
      <View style={styles.row}>
        {/* P2P sharing is Android-only for now (iOS: no LocalOnlyHotspot; Phase 3b-0 adds no iOS features). */}
        {Platform.OS === 'android' ? (
          <>
            <Button testID="library-share" label={t.transfer.share} onPress={() => { router.push('/share'); }} disabled={busy} />
            <Button testID="library-receive" label={t.transfer.receive} onPress={() => { router.push('/receive'); }} disabled={busy} />
          </>
        ) : null}
      </View>
      <View style={{ gap: 4 }}>
        <Button testID="library-maps" label={t.library.mapsAndPlaces} hint={t.library.mapsAndPlacesHint} onPress={() => { router.push('/maps'); }} />
        <Text style={styles.muted}>{t.library.mapsAndPlacesHint}</Text>
      </View>
      <View style={{ gap: 4 }}>
        <Text style={styles.mono} testID="catalog-info">
          {catalog ? t.library.catalog({ sequence: catalog.sequence, keys: catalogState?.purpose ?? '–', packs: catalog.packs.length }) : t.library.noCatalog}
        </Text>
        {catalogState?.rejected.map((r) => (
          <Text key={`${r.origin}-${r.reason}`} style={styles.error} testID="catalog-rejected">
            {t.library.catalogRejected({ origin: r.origin, reason: `${r.reason}: ${r.detail}` })}
          </Text>
        ))}
        {catalogState && catalogState.updateUrls.length > 0 && (
          <Button testID="catalog-update" label={t.library.checkUpdate} onPress={() => void checkUpdate()} disabled={busy} />
        )}
        {note('catalog')}
      </View>

      <View style={{ gap: 4 }}>
        <View style={styles.row}>
          <Switch testID="allow-metered" accessibilityLabel={t.library.allowMetered} value={allowMetered} onValueChange={setAllowMetered} />
          <Text style={styles.text}>{t.library.allowMetered}</Text>
        </View>
        <Text style={styles.muted}>{t.library.allowMeteredHint}</Text>
      </View>

      <Text style={styles.title}>{t.library.installed}</Text>
      {packs.length === 0 && <Text style={styles.muted}>{t.library.none}</Text>}
      {packs.map((p) => (
        <View key={p.id} style={styles.passage} testID={`installed-${p.id}`}>
          <Text style={styles.title}>{p.title}</Text>
          <Text style={styles.muted}>
            {`${p.kind} · ${t.library.size(formatBytes(p.sizeBytes))}${p.license ? ` · ${t.library.licence(p.license)}` : ''}`}
          </Text>
          <Text style={p.verified ? styles.muted : styles.error} testID={`status-${p.id}`}>
            {p.verified ? t.library.verified : t.unverified.label}
          </Text>
          <View style={styles.row}>
            {!p.verified && p.consentAt === null && (
              <Button testID={`consent-${p.id}`} label={t.library.open} onPress={() => void consent(p)} disabled={busy} />
            )}
            <Button testID={`verify-${p.id}`} label={t.library.verify} onPress={() => void verify(p)} disabled={busy} />
            <Button testID={`remove-${p.id}`} label={t.library.remove} tone="danger" onPress={() => void remove(p)} disabled={busy} />
          </View>
          {note(p.id)}
        </View>
      ))}
      {reconcile && reconcile.rejectedModels.length > 0 && (
        <Text style={styles.error} testID="rejected-models">
          {t.library.rejectedModels(reconcile.rejectedModels.join(', '))}
        </Text>
      )}
      {reconcile && reconcile.rejectedMaps.length > 0 && (
        <Text style={styles.error} testID="rejected-maps">
          {t.library.rejectedMaps(reconcile.rejectedMaps.join(', '))}
        </Text>
      )}
      {reconcile &&
        (['space', 'mismatch', 'failed'] as const).map((reason) => {
          const files = reconcile.legacyKept.filter((k) => k.reason === reason).map((k) => k.file);
          if (files.length === 0) return null;
          const text = reason === 'space' ? t.library.legacySpace : reason === 'mismatch' ? t.library.legacyMismatch : t.library.legacyFailed;
          return (
            <Text key={reason} style={styles.error} testID={`legacy-${reason}`}>
              {text(files.join(', '))}
            </Text>
          );
        })}
      <Button testID="library-import" label={t.library.import} onPress={() => void importFile()} disabled={busy} />
      {note('import')}

      <Text style={styles.title}>{t.library.available}</Text>
      {available.length === 0 && <Text style={styles.muted}>{t.library.none}</Text>}
      {available.map((p) => {
        const d = downloads[p.id];
        const pr = d?.progress ?? null;
        return (
          <View key={p.id} style={styles.passage} testID={`available-${p.id}`}>
            <Text style={styles.title}>{title(p)}</Text>
            <Text style={styles.muted}>{`${t.library.size(formatBytes(p.sizeBytes))} · ${t.library.licence(p.license)} · ${p.attribution}`}</Text>
            <View style={styles.row}>
              {d?.running ? (
                <Button testID={`cancel-${p.id}`} label={t.library.cancel} tone="danger" onPress={() => { cancelDownload(p.id); }} />
              ) : (
                <Button testID={`download-${p.id}`} label={t.library.download} onPress={() => void download(p)} disabled={!catalog} />
              )}
            </View>
            {pr && d?.running && (
              <Text style={styles.muted} testID={`progress-${p.id}`}>
                {t.library.progress({
                  phase: t.library.phase[pr.phase],
                  percent: pr.totalBytes > 0 ? Math.min(100, Math.round((pr.bytes / pr.totalBytes) * 100)) : 0,
                  mirror: pr.mirror + 1,
                  rejected: pr.rejectedMirrors,
                })}
              </Text>
            )}
            {d?.result && (
              <Text style={d.result.kind === 'failed' ? styles.error : styles.muted} testID={`result-${p.id}`}>
                {d.result.kind === 'failed' ? t.library.failed(d.result.reason ?? '') : t.library.phase[d.result.kind]}
              </Text>
            )}
            {note(p.id)}
          </View>
        );
      })}

      <Button
        testID="library-onboarding"
        label={t.onboarding.restart}
        onPress={() => {
          restartOnboarding();
          router.push('/onboarding');
        }}
      />

      <Text style={styles.mono} testID="network-log">
        {t.library.networkLog({
          count: networkLog.length,
          hosts: [...new Set(networkLog.map((e) => `${e.host}${e.port > 0 ? `:${String(e.port)}` : ''}`))].join(', '),
        })}
      </Text>
    </ScrollView>
  );
}
