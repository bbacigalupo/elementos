import { useEffect, useRef } from "react";
import {
  buildMarkerHtml,
  getMarkerAnchor,
  getMarkerSize,
  TILE_THEMES,
  type MarkerConfig,
  type TileConfig,
  type TileThemeName,
} from "./map-config.ts";
import "leaflet/dist/leaflet.css";

/**
 * Mapa de confirmación con pin ajustable (Leaflet + tiles OSM).
 *
 * Leaflet y no MapLibre GL: en pruebas reales MapLibre quedaba en blanco en
 * in-app browsers (WhatsApp/Instagram) y Android viejo — su worker interno
 * colgaba sin error. Leaflet pinta tiles como <img> normales, sin WebGL ni
 * workers: máxima compatibilidad con los dispositivos reales de la gente.
 *
 * El mapa es AYUDA visual, no requisito: si los tiles no cargan en 6 s se
 * avisa vía onStatus("failed") y el flujo permite confirmar solo con texto.
 */

type MapInstance = import("leaflet").Map;
type MarkerInstance = import("leaflet").Marker;

export interface ConfirmMapProps {
  lat: number;
  lng: number;
  /** Zoom inicial; ~17 para dirección exacta, ~13 para centro de zona. */
  zoom: number;
  onMove: (lat: number, lng: number) => void;
  onStatus?: (status: "ready" | "failed") => void;
  /**
   * Mueve el pin y la vista a un punto decidido fuera del mapa (por ejemplo
   * "centrar en mi ubicación"). Se aplica cada vez que cambia `nonce`, así
   * repetir el mismo punto vuelve a centrar.
   */
  recenterTo?: { lat: number; lng: number; nonce: number } | null;
  /** Preset de estilo del mapa. */
  tileTheme?: TileThemeName;
  /** Capa de tiles propia; tiene prioridad sobre `tileTheme`. */
  tiles?: TileConfig;
  /** Apariencia del marcador. */
  marker?: MarkerConfig;
  className?: string;
}

export function ConfirmMap({
  lat,
  lng,
  zoom,
  onMove,
  onStatus,
  recenterTo,
  tileTheme = "carto-positron",
  tiles,
  marker: markerConfig,
  className,
}: ConfirmMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const markerRef = useRef<MarkerInstance | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const tileLayerRef = useRef<import("leaflet").TileLayer | null>(null);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  // lat/lng/zoom solo posicionan el mapa al montar: después el pin que la
  // persona mueve es la autoridad (las props del padre lo siguen, no al revés).
  const initialRef = useRef({ lat, lng, zoom });

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    const failTimer = window.setTimeout(() => {
      if (!cancelled) onStatusRef.current?.("failed");
    }, 6000);

    void (async () => {
      // Import dinámico: Leaflet toca `window` al cargarse, así el paquete
      // no rompe SSR. `.default ?? mod` cubre bundlers ESM y CJS.
      const mod = await import("leaflet");
      const leaflet = (mod as { default?: typeof import("leaflet") }).default ?? mod;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;

      const { lat: iLat, lng: iLng, zoom: iZoom } = initialRef.current;
      const map = leaflet
        .map(containerRef.current, { zoomControl: true })
        .setView([iLat, iLng], iZoom);

      const tileConfig = tiles ?? TILE_THEMES[tileTheme] ?? TILE_THEMES.osm;
      const tileLayer = leaflet
        .tileLayer(tileConfig.url, {
          attribution: tileConfig.attribution,
          maxZoom: tileConfig.maxZoom ?? 19,
          ...(tileConfig.subdomains ? { subdomains: tileConfig.subdomains } : {}),
          ...(tileConfig.tileSize ? { tileSize: tileConfig.tileSize } : {}),
          ...(tileConfig.zoomOffset != null ? { zoomOffset: tileConfig.zoomOffset } : {}),
          ...(tileConfig.detectRetina ? { detectRetina: true } : {}),
        })
        .addTo(map);
      tileLayerRef.current = tileLayer;
      tileLayer.on("load", () => {
        if (!cancelled) {
          window.clearTimeout(failTimer);
          onStatusRef.current?.("ready");
        }
      });

      // Ícono SVG inline: el default de Leaflet depende de imágenes cuya
      // ruta los bundlers resuelven mal (problema clásico y evitable), y
      // así el marcador se puede brandear sin assets externos.
      const pinIcon = leaflet.divIcon({
        className: "ari-pin-wrap",
        html: buildMarkerHtml(markerConfig),
        iconSize: getMarkerSize(markerConfig),
        iconAnchor: getMarkerAnchor(markerConfig),
      });

      const marker = leaflet
        .marker([iLat, iLng], { draggable: true, icon: pinIcon })
        .addTo(map);

      marker.on("dragend", () => {
        const pos = marker.getLatLng();
        onMoveRef.current(pos.lat, pos.lng);
      });

      // Tocar el mapa mueve el pin ahí directo: en pantalla chica, arrastrar
      // con precisión es incómodo (sobre todo en mobile); tocar el punto es
      // más rápido. El arrastre queda para el ajuste fino.
      map.on("click", (e: import("leaflet").LeafletMouseEvent) => {
        marker.setLatLng(e.latlng);
        onMoveRef.current(e.latlng.lat, e.latlng.lng);
      });

      mapRef.current = map;
      markerRef.current = marker;
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(failTimer);
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cambiar el estilo o el marcador no debe obligar a remontar el mapa: se
  // reemplaza la capa y el ícono en vivo, conservando la posición del pin.
  const firstTileRef = useRef(true);
  useEffect(() => {
    if (firstTileRef.current) {
      firstTileRef.current = false;
      return;
    }
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!map || !leaflet) return;
    const config = tiles ?? TILE_THEMES[tileTheme] ?? TILE_THEMES.osm;
    tileLayerRef.current?.remove();
    tileLayerRef.current = leaflet
      .tileLayer(config.url, {
        attribution: config.attribution,
        maxZoom: config.maxZoom ?? 19,
        ...(config.subdomains ? { subdomains: config.subdomains } : {}),
        ...(config.tileSize ? { tileSize: config.tileSize } : {}),
        ...(config.zoomOffset != null ? { zoomOffset: config.zoomOffset } : {}),
        ...(config.detectRetina ? { detectRetina: true } : {}),
      })
      .addTo(map);
  }, [tileTheme, tiles]);

  const markerJson = JSON.stringify(markerConfig ?? {});
  const firstMarkerRef = useRef(true);
  useEffect(() => {
    if (firstMarkerRef.current) {
      firstMarkerRef.current = false;
      return;
    }
    const leaflet = leafletRef.current;
    const marker = markerRef.current;
    if (!leaflet || !marker) return;
    marker.setIcon(
      leaflet.divIcon({
        className: "ari-pin-wrap",
        html: buildMarkerHtml(markerConfig),
        iconSize: getMarkerSize(markerConfig),
        iconAnchor: getMarkerAnchor(markerConfig),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerJson]);

  // Recentrado pedido desde fuera. No llama a onMove: quien lo pide ya
  // conoce el punto y actualiza el estado por su cuenta.
  const lastNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!recenterTo || recenterTo.nonce === lastNonceRef.current) return;
    lastNonceRef.current = recenterTo.nonce;
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    marker.setLatLng([recenterTo.lat, recenterTo.lng]);
    map.setView([recenterTo.lat, recenterTo.lng], Math.max(map.getZoom(), 16));
  }, [recenterTo]);

  return <div ref={containerRef} className={className} style={{ width: "100%", height: "100%" }} />;
}
