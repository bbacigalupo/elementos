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
 * - `carto-voyager`: moderno y con algo más de color y contexto (parques,
 *   áreas), manteniéndose mucho más limpio que el estándar.
 * - `carto-dark`: equivalente oscuro, para interfaces en modo oscuro.
 *
 * Los estilos CARTO son gratuitos con atribución bajo uso razonable; para
 * volumen de producción conviene revisar sus términos y considerar un plan
 * pagado, otro proveedor con key (Stadia, MapTiler) o tiles propias.
 */
export type TileThemeName =
  | "osm"
  | "carto-positron"
  | "carto-positron-xl"
  | "carto-voyager"
  | "carto-dark";

const OSM_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} © <a href="https://carto.com/attributions">CARTO</a>`;

export const TILE_THEMES: Record<TileThemeName, TileConfig> = {
  osm: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_ATTRIBUTION,
    maxZoom: 19,
  },
  "carto-positron": {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 20,
  },
  /**
   * Positron con todo dibujado al doble: se piden tiles de un zoom más
   * lejano y se muestran al doble de tamaño, así calles y nombres crecen
   * 2x. Se pierde detalle fino y en pantallas densas se ve algo menos
   * nítido — es el intercambio inevitable con tiles raster. Útil para
   * público mayor o pantallas chicas.
   */
  "carto-positron-xl": {
    url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 20,
    tileSize: 512,
    zoomOffset: -1,
  },
  "carto-voyager": {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 20,
  },
  "carto-dark": {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attribution: CARTO_ATTRIBUTION,
    subdomains: "abcd",
    maxZoom: 20,
  },
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
