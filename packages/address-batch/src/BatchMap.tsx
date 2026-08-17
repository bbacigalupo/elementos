import { useEffect, useRef } from "react";
import {
  TILE_THEMES,
  boundsFor,
  tileLayerOptions,
  type BatchResultRow,
  type BatchStatus,
  type TileConfig,
  type TileThemeName,
} from "@allride/geo-core";
import "leaflet/dist/leaflet.css";

/**
 * Mapa del lote: todos los puntos a la vez, o uno solo para inspección.
 *
 * Es el mismo componente en los dos casos a propósito. Un mapa "de detalle"
 * aparte sería otro montaje de Leaflet, otro encuadre y otra oportunidad de
 * que los dos se comporten distinto ante el mismo dato.
 *
 * Leaflet y no MapLibre GL, por la misma razón validada en terreno en el
 * elemento individual: MapLibre queda en blanco en in-app browsers y
 * Android viejo. Se carga con `import()` diferido —junto con su CSS— así
 * que un despliegue que nunca abre el mapa no paga sus ~150 KB.
 */

type MapInstance = import("leaflet").Map;
type CircleMarkerInstance = import("leaflet").CircleMarker;

/**
 * Variable CSS de la que sale el color de cada estado.
 *
 * Los colores no se escriben acá: se leen de las mismas variables que pintan
 * los chips de la tabla. Tenerlos duplicados ya había fallado —el punto de
 * una fila corregida salía azul mientras su chip era verde, un color que no
 * correspondía a ningún estado— y además rompía el retintado: cambiar
 * `--arb-ok-fg` en la app repintaba la tabla pero no el mapa.
 *
 * `corrected` comparte color con `ok` a propósito, igual que su chip: las
 * dos son filas resueltas, y lo que el mapa tiene que gritar es dónde queda
 * trabajo por hacer.
 */
const STATUS_VAR: Record<BatchStatus, string> = {
  ok: "--arb-ok-fg",
  corrected: "--arb-ok-fg",
  uncertain: "--arb-uncertain-fg",
  failed: "--arb-failed-fg",
  pending: "--arb-muted",
};

const STATUS_FALLBACK: Record<BatchStatus, string> = {
  ok: "#065f46",
  corrected: "#065f46",
  uncertain: "#92400e",
  failed: "#991b1b",
  pending: "#555555",
};

/** Resuelve los colores contra el elemento, para respetar el retintado. */
function statusColors(el: HTMLElement): Record<BatchStatus, string> {
  const styles = getComputedStyle(el);
  const out = {} as Record<BatchStatus, string>;
  for (const estado of Object.keys(STATUS_VAR) as BatchStatus[]) {
    out[estado] = styles.getPropertyValue(STATUS_VAR[estado]).trim() || STATUS_FALLBACK[estado];
  }
  return out;
}

export interface BatchMapProps {
  results: BatchResultRow[];
  /** Fila resaltada; se centra el mapa en ella al cambiar. */
  selectedId?: string | null;
  onSelect?: (rowId: string) => void;
  tileTheme?: TileThemeName;
  tiles?: TileConfig;
  /** Alto del mapa; por defecto lo fija la variable CSS `--arb-map-height`. */
  height?: string;
  className?: string;
}

interface Point {
  id: string;
  lat: number;
  lng: number;
  status: BatchStatus;
  label: string;
}

function pointsOf(results: BatchResultRow[]): Point[] {
  const out: Point[] = [];
  for (const result of results) {
    if (!result.value) continue;
    out.push({
      id: result.row.id,
      lat: result.value.lat,
      lng: result.value.lng,
      status: result.status,
      label: `${result.row.index}. ${result.value.formatted}`,
    });
  }
  return out;
}

export function BatchMap({
  results,
  selectedId,
  onSelect,
  tileTheme = "carto-positron",
  tiles,
  height,
  className,
}: BatchMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const leafletRef = useRef<typeof import("leaflet") | null>(null);
  const markersRef = useRef(new Map<string, CircleMarkerInstance>());
  const observerRef = useRef<ResizeObserver | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const points = pointsOf(results);
  /** Firma de los puntos: evita redibujar cuando solo cambió la selección. */
  const signature = points.map((p) => `${p.id}:${p.lat}:${p.lng}:${p.status}`).join("|");

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    void (async () => {
      // Leaflet toca `window` al cargarse: el import diferido además evita
      // romper cualquier render en servidor. `.default ?? mod` cubre ESM y CJS.
      const mod = await import("leaflet");
      const leaflet = (mod as { default?: typeof import("leaflet") }).default ?? mod;
      if (cancelled || !containerRef.current) return;
      leafletRef.current = leaflet;

      const map = leaflet.map(containerRef.current, {
        zoomControl: true,
        // Renderizado en canvas y no en SVG: con miles de direcciones, un
        // nodo del DOM por punto vuelve el paneo inusable. Es también la
        // razón por la que no hace falta una librería de clustering.
        preferCanvas: true,
        renderer: leaflet.canvas({ padding: 0.5 }),
        /*
         * Sin fundido de aparición. Leaflet desvanece cada tile con un bucle
         * propio de requestAnimationFrame, y ese bucle queda a medias si la
         * vista cambia mientras corre: los tiles terminan cargados pero con
         * opacidad casi cero y el mapa se ve gris aunque no falte nada. Para
         * una revisión de datos el fundido no aporta y sí puede romperse.
         */
        fadeAnimation: false,
      });

      /*
       * El encuadre se fija ANTES de la primera capa. Nacer en [0,0] zoom 2
       * y saltar después al lote pide una pantalla de tiles del planeta
       * entero que se descartan de inmediato: consumo regalado al proveedor
       * de tiles y un salto visible en cada apertura del mapa.
       */
      const initial = boundsFor(pointsOf(results));
      if (initial) {
        map.fitBounds(
          [
            [initial.south, initial.west],
            [initial.north, initial.east],
          ],
          { padding: [24, 24], maxZoom: 17 },
        );
      } else {
        map.setView([0, 0], 2);
      }

      const config = tiles ?? TILE_THEMES[tileTheme] ?? TILE_THEMES.osm;
      leaflet.tileLayer(config.url, tileLayerOptions(config)).addTo(map);

      mapRef.current = map;

      /*
       * Leaflet mide el contenedor una sola vez, al crearse, y no se entera
       * de ningún cambio posterior. Acá el mapa nace dentro de un panel que
       * todavía está acomodándose —al aparecer cambia el alto de la página y
       * con eso el ancho disponible— así que sin esto queda convencido de
       * ser más ancho de lo que es y pinta tiles solo en una parte: el resto
       * del mapa se ve gris.
       *
       * El ResizeObserver lo cubre de raíz, no solo este caso: también
       * rotar el teléfono, plegar una barra lateral o cambiar el tamaño de
       * la ventana.
       */
      const observer = new ResizeObserver(() => map.invalidateSize());
      observer.observe(containerRef.current);
      observerRef.current = observer;

      // Se reencuadra una vez con el tamaño real del contenedor: el primer
      // fitBounds se calculó con lo que Leaflet midió al crearse, que puede
      // no ser lo que el panel termina midiendo.
      requestAnimationFrame(() => {
        if (cancelled) return;
        map.invalidateSize();
        drawPoints();
      });
    })();

    return () => {
      cancelled = true;
      observerRef.current?.disconnect();
      observerRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Redibuja los marcadores y reencuadra. */
  function drawPoints() {
    const map = mapRef.current;
    const leaflet = leafletRef.current;
    if (!map || !leaflet) return;

    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();

    const colores = statusColors(map.getContainer());
    const current = pointsOf(results);
    for (const point of current) {
      const marker = leaflet
        .circleMarker([point.lat, point.lng], {
          radius: 7,
          fillColor: colores[point.status],
          fillOpacity: 0.85,
          // Borde blanco: es lo que mantiene el punto legible sobre mapa
          // claro u oscuro, y lo que separa dos puntos que se solapan.
          color: "#ffffff",
          weight: 2,
        })
        .addTo(map);
      marker.bindTooltip(point.label, { direction: "top", offset: [0, -8] });
      marker.on("click", () => onSelectRef.current?.(point.id));
      markersRef.current.set(point.id, marker);
    }

    const bounds = boundsFor(current);
    if (bounds) {
      map.fitBounds(
        [
          [bounds.south, bounds.west],
          [bounds.north, bounds.east],
        ],
        // maxZoom evita que un lote de un solo punto termine mirando un techo.
        { padding: [24, 24], maxZoom: 17 },
      );
    }
  }

  useEffect(() => {
    drawPoints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  // Selección venida de la tabla: centrar y destacar, sin reencuadrar todo.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    for (const [id, marker] of markersRef.current) {
      const selected = id === selectedId;
      marker.setStyle({ weight: selected ? 4 : 2, fillOpacity: selected ? 1 : 0.85 });
      marker.setRadius(selected ? 11 : 7);
      if (selected) marker.bringToFront();
    }

    if (!selectedId) return;
    const marker = markersRef.current.get(selectedId);
    if (!marker) return;
    const position = marker.getLatLng();
    // Se acerca solo si estaba muy lejos: reencuadrar en cada clic marea a
    // quien está recorriendo filas una tras otra.
    map.setView(position, Math.max(map.getZoom(), 16), { animate: true });
    marker.openTooltip();
  }, [selectedId]);

  return (
    <div
      ref={containerRef}
      className={`arb-map ${className ?? ""}`}
      style={height ? { height } : undefined}
    />
  );
}

export default BatchMap;
