import { buildManifest, encodePairing, fromBase64, toBase64, TRANSFER_VERSION } from '@skepi/core';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Banner, Button, errorText, formatBytes } from '../components/ui';
import { useMessages } from '../lib/i18n';
import { ipc, type ApkChoice, type LocalAddress, type StationInfo, type StationStatus } from '../lib/ipc';
import { useApp } from '../lib/store';

/**
 * Station mode: the desktop serves the selected packs to many phones on the LAN with the P2P protocol
 * of modules/expo-transfer. The manifest is built here with `@skepi/core` (as on mobile); the native
 * side checks it against app.db and serves files it maps itself, never anything else.
 */
export function StationScreen() {
  const t = useMessages();
  const packs = useApp((s) => s.packs);
  const catalog = useApp((s) => s.catalog);
  const shareable = packs.filter((p) => p.verified || p.kind === 'zim');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [addresses, setAddresses] = useState<LocalAddress[]>([]);
  const [host, setHost] = useState('');
  const [apk, setApk] = useState<ApkChoice | null>(null);
  const [withApk, setWithApk] = useState(false);
  const [info, setInfo] = useState<StationInfo | null>(null);
  const [status, setStatus] = useState<StationStatus | null>(null);
  const [qr, setQr] = useState<{ pairing: string; code: string; apk: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const running = status?.running === true;

  useEffect(() => {
    void ipc.stationAddresses().then((list) => {
      setAddresses(list);
      setHost((h) => h || (list[0]?.ip ?? ''));
    });
    void ipc.stationStatus().then((s) => {
      setInfo(s.info);
      setStatus(s.status);
    });
  }, []);

  // Status while serving (requests, phones, bytes; idle stop).
  useEffect(() => {
    if (!info) return;
    const timer = setInterval(() => {
      void ipc.stationStatus().then((s) => {
        setStatus(s.status);
      });
    }, 1500);
    return () => {
      clearInterval(timer);
    };
  }, [info]);

  useEffect(() => {
    if (!info) {
      setQr(null);
      return;
    }
    const code = encodePairing({ v: TRANSFER_VERSION, host: info.host, port: info.port, token: info.token, certSha256: info.certSha256 });
    void Promise.all([QRCode.toDataURL(code, { margin: 1, width: 280 }), info.apkUrl ? QRCode.toDataURL(info.apkUrl, { margin: 1, width: 200 }) : Promise.resolve(null)]).then(
      ([pairing, apkQr]) => {
        setQr({ pairing, code, apk: apkQr });
      },
    );
  }, [info]);

  const start = async (): Promise<void> => {
    setError(null);
    const rows = shareable.filter((p) => selected.has(p.id));
    if (rows.length === 0) {
      setError(t.desktop.station.noPacks);
      return;
    }
    setStarting(true);
    try {
      const doc = catalog?.bytesBase64 && catalog.signature ? { bytes: fromBase64(catalog.bytesBase64), signature: catalog.signature } : null;
      const manifest = buildManifest(rows, doc, toBase64);
      const started = await ipc.stationStart(host, rows.map((r) => r.id), JSON.stringify(manifest), withApk);
      setInfo(started);
      setStatus((await ipc.stationStatus()).status);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (): Promise<void> => {
    await ipc.stationStop();
    setStatus((await ipc.stationStatus()).status);
  };

  return (
    <section className="stack" data-testid="station-screen">
      <h1>{t.desktop.station.title}</h1>
      <p>{t.desktop.station.intro}</p>
      <Banner tone="info" testId="firewall-note">
        <strong>{t.desktop.station.firewallTitle}</strong>
        <div>{t.desktop.station.firewall}</div>
      </Banner>

      <h2>{t.transfer.choosePacks}</h2>
      {shareable.length === 0 && <p className="muted">{t.transfer.noPacks}</p>}
      {shareable.map((p) => (
        <label key={p.id} className="check">
          <input
            type="checkbox"
            data-testid={`station-pack-${p.id}`}
            disabled={running}
            checked={selected.has(p.id)}
            onChange={() => {
              setSelected((cur) => {
                const next = new Set(cur);
                if (next.has(p.id)) next.delete(p.id);
                else next.add(p.id);
                return next;
              });
            }}
          />
          {p.title} <span className="muted">· {formatBytes(p.sizeBytes)}</span>
          {!p.verified && <span className="unverified">{t.unverified.label}</span>}
        </label>
      ))}

      <h2>{t.desktop.station.address}</h2>
      {addresses.length === 0 ? (
        <Banner tone="warning" testId="no-address">
          {t.desktop.station.noAddress}
        </Banner>
      ) : (
        <select
          data-testid="station-address"
          value={host}
          disabled={running}
          onChange={(e) => {
            setHost(e.target.value);
          }}
        >
          {addresses.map((a) => (
            <option key={a.ip} value={a.ip}>
              {a.ip} · {a.adapter}
              {a.virtualAdapter ? ` (${t.desktop.station.virtualAdapter})` : ''}
            </option>
          ))}
        </select>
      )}

      <label className="check">
        <input
          type="checkbox"
          data-testid="station-with-apk"
          disabled={running}
          checked={withApk}
          onChange={(e) => {
            setWithApk(e.target.checked);
          }}
        />
        {t.desktop.station.apk}
      </label>
      {withApk && (
        <div className="row">
          <Button
            testId="station-choose-apk"
            tone="plain"
            label={t.desktop.station.chooseApk}
            disabled={running}
            onClick={() =>
              void ipc.stationChooseApk().then(
                (c) => {
                  if (c) setApk(c);
                },
                (e: unknown) => {
                  setError(errorText(e));
                },
              )
            }
          />
          {apk && (
            <span data-testid="station-apk">
              {t.desktop.station.apkChosen(apk.fileName)} · {t.desktop.station.apkFingerprint(apk.signingSha256)}
            </span>
          )}
        </div>
      )}

      <div className="row">
        {!running ? (
          <Button testId="station-start" label={starting ? t.desktop.station.starting : t.desktop.station.start} disabled={starting || addresses.length === 0} onClick={() => void start()} />
        ) : (
          <Button testId="station-stop" tone="danger" label={t.desktop.station.stop} onClick={() => void stop()} />
        )}
      </div>
      {error && (
        <Banner tone="danger" testId="station-error">
          {error}
        </Banner>
      )}

      {status && !status.running && status.stopReason && <p className="muted">{t.desktop.station.stopped(status.stopReason)}</p>}
      {running && info && qr && (
        <div className="stack" data-testid="station-running">
          <p data-testid="station-status">
            {t.desktop.station.running({ phones: status.peers.length, requests: status.requests, mb: (status.bytesServed / 1e6).toFixed(1) })}
          </p>
          <p>{t.desktop.station.scanHint}</p>
          <img className="qr" src={qr.pairing} alt="pairing QR code" data-testid="station-qr" />
          <details>
            <summary>{t.desktop.station.code}</summary>
            <code data-testid="station-code">{qr.code}</code>
          </details>
          {info.apkUrl && qr.apk && (
            <div className="stack">
              <h2>{t.transfer.apkTitle}</h2>
              <p>{t.transfer.apkHint(info.apkUrl)}</p>
              <img className="qr" src={qr.apk} alt="install page QR code" />
              {info.apkCertSha256 && <p className="mono">{t.transfer.apkFingerprint(info.apkCertSha256)}</p>}
            </div>
          )}
          <p className="muted">{t.desktop.station.idleHint}</p>
          <h2>{t.desktop.station.log}</h2>
          <table className="log" data-testid="station-log">
            <tbody>
              {status.log.map((l) => (
                <tr key={`${String(l.atMs)}-${l.peer}-${l.path}`}>
                  <td>{new Date(l.atMs).toLocaleTimeString()}</td>
                  <td>{l.peer}</td>
                  <td>{l.method}</td>
                  <td>{l.path}</td>
                  <td>{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
