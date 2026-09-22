/**
 * Capas de tiles para los mapas de los elementos.
 *
 * Viven en el núcleo y no en un paquete de UI porque son **datos sobre
 * proveedores** —URL, atribución, límites de zoom—, del mismo tipo que los
 * proveedores de geocoding que ya están acá. Los necesitan tanto la captura
 * individual como la carga masiva, y tenerlos dos veces garantizaba que
 * tarde o temprano quedaran desincronizados.
 *
 * Nada de esto toca el DOM ni Leaflet: es configuración que el componente
 * de turno traduce a su librería de mapas.
 */

export interface TileConfig {
  url: string;
  attribution: string;
  maxZoom?: number;
  subdomains?: string;
  /**
   * Píxeles CSS que ocupa cada tile. Subirlo a 512 junto con
   * `zoomOffset: -1` agranda calles y nombres al doble, a costa de algo de
   * detalle: útil cuando el basemap trae etiquetas muy chicas.
   */
  tileSize?: number;
  zoomOffset?: number;
  /**
   * NO activar junto con `{r}` en la URL: `{r}` ya pide tiles @2x en
   * pantallas densas por su cuenta, y `detectRetina` además baja el tile a
   * 128px y trae contenido de un zoom más profundo. Los dos juntos reducen
   * el contenido 4x y dejan los nombres de calle ilegibles.
   */
  detectRetina?: boolean;
  /**
   * Capa extra de calles/nombres dibujada ENCIMA de `url`, sin capturar
   * clics — para basemaps como Esri Light/Dark Gray Canvas, que sirven el
   * fondo gris y las etiquetas como dos servicios de tiles separados (a
   * diferencia de CARTO, que los combina en un solo tile). Quien consuma
   * `TileConfig` necesita crear un pane propio para esto — ver
   * `LABELS_PANE`/`LABELS_PANE_Z_INDEX` y `overlayLayerOptions()`.
   */
  overlay?: TileOverlay;
}

export interface TileOverlay {
  url: string;
  maxZoom?: number;
  tileSize?: number;
  zoomOffset?: number;
}

/**
 * Presets de estilo de mapa.
 *
 * - `osm`: el estándar de OpenStreetMap. Gratis y sin condiciones más allá
 *   de la atribución, pero cargado de POIs (farmacias, bancos, comercios)
 *   que no aportan nada al confirmar una dirección y compiten con el pin.
 * - `carto-positron`: el más limpio. Gris claro, casi sin íconos de POI,
 *   calles y nombres legibles. La mejor opción para que el pin sea lo
 *   único que destaque.
 * - `carto-voyager`: alias de `carto-positron` (ver nota de abajo) —
 *   antes era una variante con más color, hoy renderiza igual.
 * - `carto-dark`: equivalente oscuro, para interfaces en modo oscuro.
 *
 * **Los nombres se mantienen por compatibilidad, pero desde el 22 sept
 * 2026 NINGUNO de los cuatro sirve tiles de CARTO.** CARTO cortó el acceso
 * anónimo/sin clave a sus basemaps (verificado con `curl`: las cuatro URLs
 * `*.basemaps.cartocdn.com` devuelven 200 con un tile idéntico de 1718
 * bytes que dice "API KEY REQUIRED", sin importar la URL pedida ni el
 * `Referer` — no es una cuota agotada de AllRide, es que ya no hay tier
 * gratis sin cuenta). Se reemplazó por Esri World Light/Dark Gray Canvas
 * (`server.arcgisonline.com`), que sigue sin pedir clave y tiene el mismo
 * espíritu "gris limpio, casi sin POIs" — mismo basemap que ya se usa en
 * el optimizador de rutas. A diferencia de CARTO, Esri sirve el fondo y
 * las etiquetas como dos capas separadas (`overlay` en `TileConfig`); no
 * hay equivalente gratis y sin clave para el look más colorido de
 * `carto-voyager`, así que queda igual a `carto-positron` hasta que se
 * pague un proveedor con clave (Stadia, MapTiler, Mapbox — ya integrado
 * en `providers/mapbox.ts` para geocoding, no para tiles).
 */
export type TileThemeName =
  | "osm"
  | "carto-positron"
  | "carto-positron-xl"
  | "carto-voyager"
  | "carto-dark";

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const ESRI_ATTRIBUTION = "Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors";

const ESRI_LIGHT_GRAY: TileConfig = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: ESRI_ATTRIBUTION,
  maxZoom: 16,
  overlay: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
  },
};

const ESRI_DARK_GRAY: TileConfig = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  attribution: ESRI_ATTRIBUTION,
  maxZoom: 16,
  overlay: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
    maxZoom: 16,
  },
};

export const TILE_THEMES: Record<TileThemeName, TileConfig> = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
  },
  "carto-positron": ESRI_LIGHT_GRAY,
  /**
   * Positron con todo dibujado al doble: se piden tiles de un zoom más
   * lejano y se muestran al doble de tamaño, así calles y nombres crecen
   * 2x. Se pierde detalle fino y en pantallas densas se ve algo menos
   * nítido — es el intercambio inevitable con tiles raster. Útil para
   * público mayor o pantallas chicas. El truco (`tileSize`/`zoomOffset`)
   * es puramente de Leaflet — funciona igual sobre Esri que sobre CARTO.
   */
  "carto-positron-xl": { ...ESRI_LIGHT_GRAY, tileSize: 512, zoomOffset: -1 },
  "carto-voyager": ESRI_LIGHT_GRAY,
  "carto-dark": ESRI_DARK_GRAY,
};

/** Opciones de capa listas para pasarle a Leaflet, sin claves indefinidas. */
export function tileLayerOptions(config: TileConfig): Record<string, unknown> {
  return {
    attribution: config.attribution,
    maxZoom: config.maxZoom ?? 19,
    ...(config.subdomains ? { subdomains: config.subdomains } : {}),
    ...(config.tileSize ? { tileSize: config.tileSize } : {}),
    ...(config.zoomOffset != null ? { zoomOffset: config.zoomOffset } : {}),
    ...(config.detectRetina ? { detectRetina: true } : {}),
  };
}

/** Pane de Leaflet para la capa `overlay` (etiquetas): por encima de los
 * tiles base y de las polilíneas, por debajo de marcadores y popups, y sin
 * capturar clics (es puro dibujo, tocar el mapa debe llegar al mapa). */
export const LABELS_PANE = "ari-labels";
export const LABELS_PANE_Z_INDEX = 450;

/** Opciones de la capa `overlay`, listas para pasarle a Leaflet. */
export function overlayLayerOptions(overlay: TileOverlay): Record<string, unknown> {
  return {
    pane: LABELS_PANE,
    maxZoom: overlay.maxZoom ?? 19,
    ...(overlay.tileSize ? { tileSize: overlay.tileSize } : {}),
    ...(overlay.zoomOffset != null ? { zoomOffset: overlay.zoomOffset } : {}),
  };
}

/**
 * Forma mínima de `L.Map` que hace falta acá — tipado estructural a
 * propósito, para no declarar `leaflet` como dependencia de este paquete
 * (geo-core es de 0 dependencias) solo por un tipo. Cualquier instancia
 * real de Leaflet la cumple sin cast.
 */
interface LeafletPaneHost {
  getPane(name: string): { style: { zIndex: string; pointerEvents: string } } | undefined;
  createPane(name: string): { style: { zIndex: string; pointerEvents: string } };
}

/** Crea el pane de etiquetas si el mapa todavía no lo tiene. Idempotente. */
export function ensureLabelsPane(map: LeafletPaneHost): void {
  if (map.getPane(LABELS_PANE)) return;
  const pane = map.createPane(LABELS_PANE);
  pane.style.zIndex = String(LABELS_PANE_Z_INDEX);
  pane.style.pointerEvents = "none";
}

/** Encuadre que contiene todos los puntos, con un margen mínimo cuando es uno solo. */
export function boundsFor(
  points: Array<{ lat: number; lng: number }>,
): { south: number; west: number; north: number; east: number } | null {
  if (points.length === 0) return null;
  let south = points[0].lat;
  let north = points[0].lat;
  let west = points[0].lng;
  let east = points[0].lng;
  for (const p of points) {
    south = Math.min(south, p.lat);
    north = Math.max(north, p.lat);
    west = Math.min(west, p.lng);
    east = Math.max(east, p.lng);
  }
  // Un solo punto (o varios idénticos) da un rectángulo de área cero, y
  // encuadrar eso lleva al zoom máximo sobre un techo sin contexto.
  if (north - south < 0.002 && east - west < 0.002) {
    south -= 0.001;
    north += 0.001;
    west -= 0.001;
    east += 0.001;
  }
  return { south, west, north, east };
}
