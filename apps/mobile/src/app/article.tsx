import { Stack, useLocalSearchParams } from 'expo-router';
import { ExpoZim, ZimArticleView, zimUrl } from 'expo-zim';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useStyles, UnverifiedLabel } from '../components/ui';
import { useMessages } from '../lib/i18n';
import { isArchiveId } from '../lib/openArchives';
import { usePrefs } from '../lib/prefs';

export default function ArticleScreen() {
  const styles = useStyles();
  const blackout = usePrefs((s) => s.blackout);
  const t = useMessages();
  const params = useLocalSearchParams<{ archiveId: string; path: string; title?: string; anchor?: string }>();
  const url = useMemo(
    () => zimUrl(params.archiveId, params.path, params.anchor),
    [params.archiveId, params.path, params.anchor],
  );
  const startedAt = useRef(performance.now());
  const [openMs, setOpenMs] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<number | null>(null);
  const [external, setExternal] = useState<string | null>(null);

  const refreshBlocked = useCallback(async () => {
    const list = await ExpoZim.getBlockedRequests();
    setBlocked(list.length);
  }, []);

  useEffect(() => {
    startedAt.current = performance.now();
    setOpenMs(null);
  }, [url]);

  // Deep links carry the archive id: anything but a UUID (another spelling, user info, a port) never opens.
  if (!isArchiveId(params.archiveId)) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted} testID="content-missing">
          {t.content.missing}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.fill}>
      <Stack.Screen options={{ title: params.title ?? t.article.title }} />
      <View style={{ paddingHorizontal: 8 }}>
        <UnverifiedLabel archiveId={params.archiveId} />
      </View>
      <View style={[styles.row, { padding: 8 }]}>
        <Text style={styles.muted} testID="article-open-ms">
          {openMs === null ? t.common.loading : t.article.opened(openMs.toFixed(0))}
        </Text>
        <Text style={styles.muted} testID="blocked-count">
          {t.article.blockedRequests(blocked)}
        </Text>
      </View>
      {external && (
        <Text style={[styles.muted, { paddingHorizontal: 8 }]} testID="external-link">
          {t.article.externalLink(external)}
        </Text>
      )}
      <ZimArticleView
        testID="article-view"
        style={{ flex: 1 }}
        url={url}
        dark={blackout}
        onLoadEnd={() => {
          setOpenMs(performance.now() - startedAt.current);
          void refreshBlocked();
        }}
        onBlockedRequest={() => void refreshBlocked()}
        onExternalLink={(e) => {
          setExternal(e.nativeEvent.url);
        }}
      />
    </View>
  );
}
