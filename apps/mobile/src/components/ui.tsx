import { MIN_TOUCH_DP, TYPE, type Theme, type ThemeName } from '@skepi/ui-tokens';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useContent } from '../lib/content';
import { useMessages } from '../lib/i18n';
import { showsUnverifiedLabel } from '../lib/openArchives';
import { useTheme } from '../lib/theme';

function makeStyles(c: Theme) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.bg, padding: 12, gap: 8 },
    fill: { flex: 1, backgroundColor: c.bg },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 16, backgroundColor: c.bg },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: TYPE.body,
      color: c.text,
      minHeight: MIN_TOUCH_DP,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
    button: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8, minHeight: MIN_TOUCH_DP, minWidth: MIN_TOUCH_DP, justifyContent: 'center' },
    buttonAccent: { backgroundColor: c.accent },
    buttonDanger: { backgroundColor: c.danger },
    buttonText: { color: c.onAccent, fontSize: TYPE.body, fontWeight: '600' },
    buttonTextDanger: { color: c.onDanger, fontSize: TYPE.body, fontWeight: '600' },
    buttonCost: { color: c.onAccent, fontSize: TYPE.small },
    disabled: { opacity: 0.45 },
    muted: { color: c.muted, fontSize: TYPE.small },
    text: { color: c.text, fontSize: TYPE.body, lineHeight: 24 },
    title: { color: c.text, fontSize: TYPE.title, fontWeight: '600' },
    heading: { color: c.text, fontSize: TYPE.heading, fontWeight: '700' },
    error: { color: c.danger, fontSize: TYPE.body },
    ok: { color: c.ok, fontSize: TYPE.body, fontWeight: '600' },
    item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, minHeight: MIN_TOUCH_DP },
    chip: { backgroundColor: c.chip, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 16, minHeight: MIN_TOUCH_DP, justifyContent: 'center' },
    chipText: { color: c.onChip, fontWeight: '700', fontSize: TYPE.small },
    banner: { backgroundColor: c.dangerBg, padding: 12, borderRadius: 8, gap: 4 },
    bannerText: { color: c.onDangerBg, fontWeight: '700', fontSize: TYPE.body },
    bannerBody: { color: c.onDangerBg, fontSize: TYPE.body, lineHeight: 22 },
    warning: { backgroundColor: c.warningBg, padding: 12, borderRadius: 8, gap: 6 },
    warningText: { color: c.onWarningBg, fontWeight: '700', fontSize: TYPE.body },
    card: { backgroundColor: c.surface, padding: 12, borderRadius: 8, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    mono: { fontFamily: 'monospace', fontSize: 12, color: c.text },
    passage: { gap: 6, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    highlight: { backgroundColor: c.highlight, color: c.onHighlight, fontWeight: '600' },
    summary: { backgroundColor: c.surface, padding: 12, borderRadius: 8, gap: 8 },
    summaryLabel: { color: c.muted, fontSize: TYPE.small, fontWeight: '700' },
    stickyHeader: {
      backgroundColor: c.bg,
      paddingHorizontal: 12,
      paddingTop: 12,
      paddingBottom: 8,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    link: { color: c.accent, fontSize: TYPE.small, paddingVertical: 12, minHeight: MIN_TOUCH_DP, textDecorationLine: 'underline' },
    unverified: { color: c.danger, fontWeight: '700', fontSize: TYPE.small },
    progressTrack: { height: 6, borderRadius: 3, backgroundColor: c.border, overflow: 'hidden' },
    progressFill: { height: 6, backgroundColor: c.accent },
    step: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    stepNumber: { color: c.text, fontSize: TYPE.step, fontWeight: '700', minWidth: 28 },
    stepText: { color: c.text, fontSize: TYPE.step, lineHeight: 26, flexShrink: 1 },
  });
}

type Styles = ReturnType<typeof makeStyles>;
const cache = new Map<ThemeName, Styles>();

/** Styles for the current theme (light, or pure black in blackout mode). */
export function useStyles(): Styles {
  const theme = useTheme();
  let s = cache.get(theme.name);
  if (!s) {
    s = makeStyles(theme);
    cache.set(theme.name, s);
  }
  return s;
}

export function Button({
  label,
  onPress,
  disabled = false,
  testID,
  tone = 'accent',
  cost,
  hint,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
  tone?: 'accent' | 'danger';
  /** Measured battery cost ("≈ 1% battery"), shown under the label of costly actions. */
  cost?: string | null;
  hint?: string;
}) {
  const styles = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={cost ? `${label}, ${cost}` : label}
      accessibilityState={{ disabled }}
      {...(hint ? { accessibilityHint: hint } : {})}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, tone === 'danger' ? styles.buttonDanger : styles.buttonAccent, disabled && styles.disabled]}
    >
      <Text style={tone === 'danger' ? styles.buttonTextDanger : styles.buttonText}>{label}</Text>
      {cost ? (
        <Text style={styles.buttonCost} testID={testID ? `${testID}-cost` : undefined}>
          {cost}
        </Text>
      ) : null}
    </Pressable>
  );
}

/** Renders children only once content has been opened; shows status otherwise. */
export function ContentGate({ children }: { children: ReactNode }) {
  const t = useMessages();
  const styles = useStyles();
  const status = useContent((s) => s.status);
  const error = useContent((s) => s.error);
  const archives = useContent((s) => s.archives);
  const verifying = useContent((s) => s.verifying);
  const animations = useTheme().animations;
  if (status === 'loading' || status === 'idle') {
    return (
      <View style={styles.center}>
        {animations && <ActivityIndicator />}
        <Text style={styles.muted} testID="content-opening">
          {verifying ? t.content.verifying(verifying) : t.content.opening}
        </Text>
      </View>
    );
  }
  if (status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.error} testID="content-error">
          {t.common.error(error ?? '')}
        </Text>
      </View>
    );
  }
  if (archives.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted} testID="content-missing">
          {t.content.missing}
        </Text>
      </View>
    );
  }
  return <>{children}</>;
}

/** Permanent label for content from an unverified pack (not in the signed catalog). */
export function UnverifiedLabel({ archiveId }: { archiveId: string }) {
  const t = useMessages();
  const styles = useStyles();
  // Fails closed: hidden only for an open, verified archive with exactly this id.
  const unverified = useContent((s) => showsUnverifiedLabel(s.archives, archiveId));
  if (!unverified) return null;
  return (
    <Text style={styles.unverified} testID="unverified-label">
      {t.unverified.label}
    </Text>
  );
}
