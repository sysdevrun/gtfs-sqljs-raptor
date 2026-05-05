import { useEffect, useMemo, useRef } from 'react';
import maplibregl, { type LngLatBoundsLike, type Map as MapLibreMap, type Marker } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { JourneyGeometry } from '../util/journeyGeometry';

export type CoordinatePick = { lat: number; lon: number };
export type PickMode = 'origin' | 'destination' | null;

interface Props {
  origin: CoordinatePick | null;
  destination: CoordinatePick | null;
  pickMode: PickMode;
  onPick: (mode: 'origin' | 'destination', point: CoordinatePick) => void;
  geometry: JourneyGeometry | null;
  /** Initial bounds applied once the map is loaded (typically the feed bbox). */
  initialBounds?: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

const WALK_SOURCE = 'journey-walks';
const TRANSIT_SOURCE = 'journey-transits';

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function geometryToWalkFc(geom: JourneyGeometry | null): GeoJSON.FeatureCollection {
  if (!geom) return emptyFc();
  return {
    type: 'FeatureCollection',
    features: geom.walks.map((w) => ({
      type: 'Feature',
      properties: { duration: w.durationSeconds, label: w.label },
      geometry: { type: 'LineString', coordinates: w.coordinates },
    })),
  };
}

function geometryToTransitFc(geom: JourneyGeometry | null): GeoJSON.FeatureCollection {
  if (!geom) return emptyFc();
  return {
    type: 'FeatureCollection',
    features: geom.transits.map((t) => ({
      type: 'Feature',
      properties: {
        fillColor: t.fillColor,
        contourColor: t.contourColor,
        routeLabel: t.routeLabel,
        headsign: t.headsign,
      },
      geometry: { type: 'LineString', coordinates: t.coordinates },
    })),
  };
}

function boundsToBbox(b: { minLat: number; minLon: number; maxLat: number; maxLon: number }): LngLatBoundsLike {
  return [
    [b.minLon, b.minLat],
    [b.maxLon, b.maxLat],
  ];
}

function makeEndpointEl(kind: 'origin' | 'destination'): HTMLElement {
  const el = document.createElement('div');
  el.className = `map-endpoint map-endpoint--${kind}`;
  el.setAttribute('aria-label', kind === 'origin' ? 'Origin coordinate' : 'Destination coordinate');
  el.textContent = kind === 'origin' ? 'A' : 'B';
  return el;
}

export function MapView({ origin, destination, pickMode, onPick, geometry, initialBounds }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const originMarkerRef = useRef<Marker | null>(null);
  const destinationMarkerRef = useRef<Marker | null>(null);
  const styleLoadedRef = useRef(false);

  // Latest values that the click handler needs without re-creating the listener
  // each render (which would tear down the map).
  const pickModeRef = useRef(pickMode);
  const onPickRef = useRef(onPick);
  useEffect(() => { pickModeRef.current = pickMode; }, [pickMode]);
  useEffect(() => { onPickRef.current = onPick; }, [onPick]);

  // One-shot map creation.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: OSM_STYLE,
      center: [0, 0],
      zoom: 1,
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    const onClick = (e: maplibregl.MapMouseEvent) => {
      const mode = pickModeRef.current;
      if (!mode) return;
      onPickRef.current(mode, { lat: e.lngLat.lat, lon: e.lngLat.lng });
    };
    map.on('click', onClick);

    map.on('load', () => {
      map.addSource(TRANSIT_SOURCE, { type: 'geojson', data: emptyFc() });
      map.addSource(WALK_SOURCE, { type: 'geojson', data: emptyFc() });

      // Transit: contour layer (wider) underneath, fill layer on top.
      map.addLayer({
        id: 'transit-contour',
        type: 'line',
        source: TRANSIT_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'contourColor'],
          'line-width': 7,
        },
      });
      map.addLayer({
        id: 'transit-fill',
        type: 'line',
        source: TRANSIT_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'fillColor'],
          'line-width': 4,
        },
      });

      // Walk legs: dashed line on top of everything else.
      map.addLayer({
        id: 'walk-line',
        type: 'line',
        source: WALK_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#1f2937',
          'line-width': 3,
          'line-dasharray': [1, 1.5],
          'line-opacity': 0.85,
        },
      });

      styleLoadedRef.current = true;
    });

    return () => {
      map.remove();
      mapRef.current = null;
      styleLoadedRef.current = false;
      originMarkerRef.current = null;
      destinationMarkerRef.current = null;
    };
  }, []);

  // Apply the initial feed bounds once the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !initialBounds) return;
    const apply = () => {
      try {
        map.fitBounds(boundsToBbox(initialBounds), { padding: 30, animate: false });
      } catch {
        // ignore — invalid bounds
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once('load', apply);
  }, [initialBounds]);

  // Update markers when origin/destination change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (origin) {
      if (!originMarkerRef.current) {
        originMarkerRef.current = new maplibregl.Marker({ element: makeEndpointEl('origin') })
          .setLngLat([origin.lon, origin.lat])
          .addTo(map);
      } else {
        originMarkerRef.current.setLngLat([origin.lon, origin.lat]);
      }
    } else if (originMarkerRef.current) {
      originMarkerRef.current.remove();
      originMarkerRef.current = null;
    }
  }, [origin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (destination) {
      if (!destinationMarkerRef.current) {
        destinationMarkerRef.current = new maplibregl.Marker({ element: makeEndpointEl('destination') })
          .setLngLat([destination.lon, destination.lat])
          .addTo(map);
      } else {
        destinationMarkerRef.current.setLngLat([destination.lon, destination.lat]);
      }
    } else if (destinationMarkerRef.current) {
      destinationMarkerRef.current.remove();
      destinationMarkerRef.current = null;
    }
  }, [destination]);

  // Push journey geometry to the map sources.
  const walkData = useMemo(() => geometryToWalkFc(geometry), [geometry]);
  const transitData = useMemo(() => geometryToTransitFc(geometry), [geometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const walkSrc = map.getSource(WALK_SOURCE) as maplibregl.GeoJSONSource | undefined;
      const transitSrc = map.getSource(TRANSIT_SOURCE) as maplibregl.GeoJSONSource | undefined;
      walkSrc?.setData(walkData);
      transitSrc?.setData(transitData);
      if (geometry?.bounds) {
        try {
          map.fitBounds(boundsToBbox(geometry.bounds), { padding: 50, maxZoom: 15 });
        } catch {
          // ignore
        }
      }
    };
    if (styleLoadedRef.current) apply();
    else map.once('load', apply);
  }, [walkData, transitData, geometry]);

  // Adjust cursor when picking.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = pickMode ? 'crosshair' : '';
  }, [pickMode]);

  return <div ref={containerRef} className="map" />;
}
