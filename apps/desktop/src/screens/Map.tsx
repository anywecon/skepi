import {
  EMERGENCY_CATEGORIES,
  installedRegions,
  mapHome,
  multiSourceStyle,
  placeTitle,
  poisToGeoJson,
  type BBox,
  type EmergencyCategory,
  type Place,
} from '@skepi/core';
import { POI_COLORS, POI_OUTLINE } from '@skepi/ui-tokens';
import { addProtocol, Map as MapLibre, NavigationControl, setWorkerUrl, type GeoJSONSource, type MapLayerMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useMemo, useRef, useState } from 'react';
import baseStyle from '../../../mobile/assets/map/style.json';
import { useNav } from '../App';
import { useMessages } from '../lib/i18n';
import { pmtilesUrl } from '../lib/maps';
import { placesAttribution, poisInView } from '../lib/places';
import { llama, useApp, verifiedPacks } from '../lib/store';

/** Below this zoom the POI layer stays empty (thousands of points would hide the map). */
const POI_MIN_ZOOM = 10;

// MapLibre 6 ships ES modules only; under a bundler the worker is a same-origin file named here (no blob: in the CSP).
setWorkerUrl(workerUrl);

/**
 * The bundled Protomaps style with local glyphs/sprites (app origin) over every verified map pack: one
 * source per installed country (core multiSourceStyle).
 */
function offlineStyle(sources: readonly { id: string; url: string }[]): StyleSpecification {
  const base = JSON.parse(JSON.stringify(baseStyle)) as StyleSpecification;
  const origin = window.location.origin;
  base.glyphs = `${origin}/map/fonts/{fontstack}/{range}.pbf`;
  base.sprite = `${origin}/map/sprites/light`;
  const style = multiSourceStyle(base as unknown as Parameters<typeof multiSourceStyle>[0], sources);
  if (!style) throw new Error('style: no map pack');
  return style as unknown as StyleSpecification;
}

export function MapScreen() {
  const t = useMessages();
  const focus = useNav((s) => s.mapFocus);
  const packs = useApp((s) => s.packs);
  const status = useApp((s) => s.status);
  const catalog = useApp((s) => s.catalog?.catalog ?? null);
  const country = useApp((s) => s.country);
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<MapLibre | null>(null);
  const [ready, setReady] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [view, setView] = useState<{ bbox: BBox; zoom: number } | null>(null);
  const [enabled, setEnabled] = useState<ReadonlySet<EmergencyCategory>>(() => new Set(EMERGENCY_CATEGORIES));
  const [pois, setPois] = useState<Place[]>([]);
  const [selected, setSelected] = useState<Place | null>(null);
  const [attribution, setAttribution] = useState<string[]>([]);
  const mapIds = useMemo(() => verifiedPacks(packs, 'pmtiles').map((p) => p.id), [packs]);
  const mapKey = mapIds.join(',');
  const placesIds = useMemo(() => verifiedPacks(packs, 'places').map((p) => p.id), [packs]);
  // Without a place to show: the chosen country (or the first installed one), whole.
  const home = useMemo(() => {
    const regions = installedRegions(catalog, packs);
    return mapHome(mapIds.flatMap((id) => regions.get(id) ?? []), country);
  }, [catalog, packs, mapIds, country]);
  const placesKey = placesIds.join(',');
  const poisRef = useRef<Place[]>([]);
  poisRef.current = pois;

  // The model and the map are not resident together on small machines: opening the map unloads it.
  useEffect(() => {
    void llama.unload().catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mapIds.length === 0 || !container.current) return;
    const started = performance.now();
    let m: MapLibre;
    try {
      m = new MapLibre({
        container: container.current,
        style: offlineStyle(
          mapIds.map((id) => ({
            id,
            url: pmtilesUrl(id, (name, handler) => {
              addProtocol(name, handler);
            }),
          })),
        ),
        center: focus ? [focus.lon, focus.lat] : home.center,
        zoom: focus ? 15 : home.zoom,
        attributionControl: false,
      });
    } catch (e) {
      // MapLibre 6 requires WebGL2: without it the constructor throws (GPUInitializationError).
      setFailed(e instanceof Error ? e.message : String(e));
      return;
    }
    map.current = m;
    if (import.meta.env.MODE === 'e2e') (window as unknown as { __skepiMap?: MapLibre }).__skepiMap = m;
    m.addControl(new NavigationControl({ showCompass: true }), 'top-right');
    const updateView = (): void => {
      const b = m.getBounds();
      setView({ bbox: { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }, zoom: m.getZoom() });
    };
    m.on('load', () => {
      setReady(Math.round(performance.now() - started));
      m.resize();
      if (m.getLayer('pois')) return;
      // POIs read before the style finished loading are drawn now.
      m.addSource('pois', { type: 'geojson', data: poisToGeoJson(poisRef.current) });
      m.addLayer({
        id: 'pois',
        type: 'circle',
        source: 'pois',
        paint: {
          'circle-radius': 7,
          'circle-color': ['match', ['get', 'category'], ...EMERGENCY_CATEGORIES.flatMap((c) => [c, POI_COLORS[c]]), '#4b5563'] as unknown as string,
          'circle-stroke-color': POI_OUTLINE,
          'circle-stroke-width': 2,
        },
      });
      if (focus) {
        m.addSource('focus', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Point', coordinates: [focus.lon, focus.lat] }, properties: {} } });
        m.addLayer({ id: 'focus', type: 'circle', source: 'focus', paint: { 'circle-radius': 10, 'circle-color': '#1d4ed8', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3 } });
      }
      updateView();
    });
    m.on('moveend', updateView);
    const observer = new ResizeObserver(() => {
      m.resize();
    });
    observer.observe(container.current);
    m.on('error', (e) => {
      setFailed(e.error.message);
    });
    m.on('click', 'pois', (e: MapLayerMouseEvent) => {
      // The feature id is the index in the POI list (poisToGeoJson): row ids repeat across packs.
      const id = e.features?.[0]?.id;
      setSelected((cur) => (typeof id === 'number' ? (poisRef.current[id] ?? cur) : cur));
    });
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
    // The map is rebuilt only for other packs or another focus place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapKey, focus]);

  useEffect(() => {
    const ids = placesKey ? placesKey.split(',') : [];
    void placesAttribution(ids).then(setAttribution, () => {
      setAttribution([]);
    });
  }, [placesKey]);

  useEffect(() => {
    const ids = placesKey ? placesKey.split(',') : [];
    if (!view || view.zoom < POI_MIN_ZOOM || ids.length === 0 || enabled.size === 0) {
      setPois([]);
      return;
    }
    let live = true;
    void poisInView(ids, view.bbox, [...enabled]).then(
      (found) => {
        if (live) setPois(found);
      },
      () => {
        if (live) setPois([]);
      },
    );
    return () => {
      live = false;
    };
  }, [view, enabled, placesKey]);

  useEffect(() => {
    const src = map.current?.getSource<GeoJSONSource>('pois');
    void src?.setData(poisToGeoJson(pois)).catch(() => undefined);
  }, [pois]);

  if (status === 'ready' && mapIds.length === 0) {
    return (
      <div className="map-bar">
        <p className="muted" data-testid="map-missing">
          {t.map.missing}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="map-bar stack" data-testid="map-screen">
        <div className="row">
          {EMERGENCY_CATEGORIES.map((c) => (
            <label key={c} className="check" style={{ minHeight: 32 }}>
              <input
                type="checkbox"
                data-testid={`poi-filter-${c}`}
                checked={enabled.has(c)}
                onChange={() => {
                  setEnabled((cur) => {
                    const next = new Set(cur);
                    if (next.has(c)) next.delete(c);
                    else next.add(c);
                    return next;
                  });
                }}
              />
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 6, background: POI_COLORS[c] }} />
              {t.map.poi[c]}
            </label>
          ))}
        </div>
        <div className="row muted">
          <span data-testid="map-status">{ready !== null ? t.map.ready(String(ready)) : failed ? t.map.failed : t.map.loading}</span>
          {failed && (
            <span className="muted" data-testid="map-error">
              {failed}
            </span>
          )}
          <span data-testid="poi-count">{placesIds.length === 0 ? t.map.noPlaces : view && view.zoom < POI_MIN_ZOOM ? t.map.zoomForPois : t.map.poiCount(pois.length)}</span>
        </div>
        {selected && (
          <div className="card" data-testid="poi-selected">
            {placeTitle(selected).title} · {placeTitle(selected).kind} · {selected.lat.toFixed(5)}, {selected.lon.toFixed(5)}
          </div>
        )}
        {focus && <div data-testid="map-focus">{focus.title}</div>}
      </div>
      <div ref={container} className="map" data-testid="map" />
      <div className="map-bar muted" data-testid="map-attribution">
        {[t.map.attribution, ...attribution.filter((a) => !t.map.attribution.includes(a.replace('©', '').trim().split(' (')[0] ?? a))].join(' · ')}
      </div>
    </>
  );
}
