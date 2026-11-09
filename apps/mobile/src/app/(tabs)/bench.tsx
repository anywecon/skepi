import type { InferenceBackend, RagSource } from '@skepi/core';
import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Switch, Text, View } from 'react-native';
import { Button, ContentGate, useStyles } from '../../components/ui';
import { runBench, type BenchReport } from '../../lib/bench';
import { exportEnergySamples, resetEnergySamples } from '../../lib/energy';
import { runHeldout } from '../../lib/heldout';
import { runParity } from '../../lib/parity';
import { useActiveProfile, useContent } from '../../lib/content';
import { useMessages } from '../../lib/i18n';
import { usePrefs } from '../../lib/prefs';

const BACKENDS: readonly InferenceBackend[] = ['cpu', 'opencl', 'hexagon'];

export default function BenchScreen() {
  const styles = useStyles();
  useKeepAwake();
  const t = useMessages();
  const simulateT1 = useContent((s) => s.simulateT1);
  const setSimulateT1 = useContent((s) => s.setSimulateT1);
  const backend = useContent((s) => s.backend);
  const setBackend = useContent((s) => s.setBackend);
  const greekUi = usePrefs((s) => s.greekUi);
  const setGreekUi = usePrefs((s) => s.setGreekUi);
  const { profile } = useActiveProfile();
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [report, setReport] = useState<BenchReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parity, setParity] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [heldout, setHeldout] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  /** The held-out archive waiting for the user's consent (unverified content). */
  const [heldoutConsent, setHeldoutConsent] = useState<{ archive: string; answer: (ok: boolean) => void } | null>(null);
  const [energyExport, setEnergyExport] = useState<string | null>(null);

  // Render probe for "sources visible": the bench shows the sources here, like the Ask screen does,
  // and the time of the first frame after React commits them is the measurement.
  const [probe, setProbe] = useState<RagSource[]>([]);
  const pending = useRef<((at: number) => void) | null>(null);
  useEffect(() => {
    const resolve = pending.current;
    if (!resolve) return;
    pending.current = null;
    const frame = requestAnimationFrame(() => {
      resolve(performance.now());
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [probe]);
  const renderSources = useCallback(
    (sources: RagSource[]) =>
      new Promise<number>((resolve) => {
        pending.current = resolve;
        setProbe(sources);
      }),
    [],
  );

  const start = async (): Promise<void> => {
    setRunning(true);
    setLines([]);
    setReport(null);
    setError(null);
    try {
      const r = await runBench(
        (line) => {
          setLines((prev) => [...prev, line]);
        },
        { simulateT1, backend, renderSources, greek: greekUi },
      );
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const startHeldout = async (): Promise<void> => {
    setRunning(true);
    setHeldout('running');
    setLines([]);
    setError(null);
    try {
      await runHeldout(
        (line) => {
          setLines((prev) => [...prev, line]);
        },
        (archive) =>
          new Promise<boolean>((resolve) => {
            setHeldoutConsent({
              archive,
              answer: (ok) => {
                setHeldoutConsent(null);
                resolve(ok);
              },
            });
          }),
      );
      setHeldout('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHeldout('error');
    } finally {
      setRunning(false);
    }
  };

  const startParity = async (): Promise<void> => {
    setRunning(true);
    setParity('running');
    setLines([]);
    setError(null);
    try {
      await runParity((line) => {
        setLines((prev) => [...prev, line]);
      });
      setParity('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setParity('error');
    } finally {
      setRunning(false);
    }
  };

  const status = running ? 'running' : report ? 'done' : error ? 'error' : 'idle';

  return (
    <ContentGate>
      <ScrollView style={styles.screen} contentContainerStyle={{ gap: 8, paddingBottom: 48 }}>
        <View style={{ gap: 4 }}>
          <Text style={styles.title}>{t.bench.developer}</Text>
          <View style={styles.row}>
            <Switch
              testID="dev-t1-simulation"
              accessibilityLabel={t.bench.t1Simulation}
              value={simulateT1}
              onValueChange={setSimulateT1}
              disabled={running}
            />
            <Text style={styles.text}>{t.bench.t1Simulation}</Text>
          </View>
          <Text style={styles.muted}>{t.bench.t1SimulationHint}</Text>
          <View style={styles.row}>
            <Switch testID="dev-greek-ui" accessibilityLabel={t.bench.greekUi} value={greekUi} onValueChange={setGreekUi} disabled={running} />
            <Text style={styles.text}>{t.bench.greekUi}</Text>
          </View>
          <Text style={styles.muted}>{t.bench.greekUiHint}</Text>
          <Text style={styles.text}>{t.bench.backend}</Text>
          <View style={styles.row}>
            {BACKENDS.map((b) => (
              <Pressable
                key={b}
                testID={`dev-backend-${b}`}
                accessibilityRole="radio"
                accessibilityState={{ selected: backend === b, disabled: running }}
                disabled={running}
                style={[styles.chip, backend === b ? { borderWidth: 2 } : null]}
                onPress={() => {
                  setBackend(b);
                }}
              >
                <Text style={styles.chipText}>{t.bench.backendOption[b]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.muted}>{t.bench.backendHint}</Text>
          <Text style={styles.mono} testID="bench-profile">
            {t.bench.profile({
              tier:
                profile.detectedTier === profile.effectiveTier
                  ? profile.detectedTier
                  : `${profile.detectedTier} → ${profile.effectiveTier}`,
              mode: profile.mode,
              model: profile.modelId ?? '–',
              threads: profile.load.threads,
              contextSize: profile.load.contextSize,
              budget: profile.budgetTier,
              summary: profile.summaryMode,
              backend: profile.backend,
            })}
          </Text>
        </View>
        <View style={styles.row}>
          <Button testID="bench-run" label={running ? t.bench.running : t.bench.run} onPress={() => void start()} disabled={running} />
          <Text style={styles.muted} testID="bench-status">
            {t.bench.status[status]}
          </Text>
        </View>
        <View style={styles.row}>
          <Button testID="bench-parity" label={t.bench.parity} onPress={() => void startParity()} disabled={running} />
          <Text style={styles.muted} testID="parity-status">
            {`parity: ${parity}`}
          </Text>
          <Button testID="bench-heldout" label="Run held-out set" onPress={() => void startHeldout()} disabled={running} />
          {heldoutConsent && (
            <View style={{ gap: 4 }} testID="heldout-consent">
              <Text style={styles.text}>{t.unverified.consentTitle}</Text>
              <Text style={styles.muted}>{t.unverified.consentBody(heldoutConsent.archive)}</Text>
              <View style={styles.row}>
                <Button
                  testID="heldout-consent-accept"
                  label={t.unverified.consentAccept}
                  onPress={() => {
                    heldoutConsent.answer(true);
                  }}
                />
                <Button
                  testID="heldout-consent-cancel"
                  label={t.unverified.cancel}
                  onPress={() => {
                    heldoutConsent.answer(false);
                  }}
                />
              </View>
            </View>
          )}
          <Text style={styles.muted} testID="heldout-status">
            {`held-out: ${heldout}`}
          </Text>
        </View>
        <View style={styles.row}>
          <Button
            testID="bench-energy-clear"
            label="Clear energy samples"
            onPress={() => {
              void resetEnergySamples().then(() => {
                setEnergyExport('cleared');
              });
            }}
            disabled={running}
          />
          <Button
            testID="bench-energy-export"
            label="Export energy samples"
            onPress={() => {
              void exportEnergySamples().then(
                (path) => {
                  setEnergyExport(path);
                },
                (e: unknown) => {
                  setError(e instanceof Error ? e.message : String(e));
                },
              );
            }}
            disabled={running}
          />
          <Text style={styles.muted} testID="energy-export-status">
            {energyExport ? `energy: ${energyExport}` : 'energy: idle'}
          </Text>
        </View>
        {probe.length > 0 && (
          <View testID="bench-probe">
            {probe.map((s) => (
              <Text key={s.id} style={styles.chipText}>
                [{s.id}] {s.title}
              </Text>
            ))}
          </View>
        )}
        {report && (
          <View style={{ gap: 4 }} testID="bench-gates">
            {Object.entries(report.gates).map(([name, g]) => (
              <Text key={name} style={styles.mono}>
                {g.gate === null
                  ? `${name}: ${g.value === null ? 'n/a' : g.value.toFixed(1)}`
                  : t.bench.gate({
                      result: g.pass === null ? 'none' : g.pass ? 'pass' : 'fail',
                      name,
                      value: g.value === null ? 'n/a' : g.value.toFixed(1),
                      limit: g.gate,
                    })}
              </Text>
            ))}
          </View>
        )}
        {lines.map((l, i) => (
          <Text key={i} style={styles.mono}>
            {l}
          </Text>
        ))}
        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </ContentGate>
  );
}
