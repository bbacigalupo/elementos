/**
 * Configuración visual del mapa: capa de tiles y marcador.
 *
 * Ambas cosas son datos, no código: se pueden cambiar por proyecto sin
 * tocar el componente.
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

/**
 * Trazado de la "manita" del logo de AllRide, tal como viene del SVG de
 * marca (viewBox 130×130, centrada en 65,65). Se reescala al insertarla en
 * el pin; no se edita el trazado para no deformar la marca.
 */
const ALLRIDE_HAND_PATH =
  "M115 68.0396C114.778 69.7297 114.599 71.4197 114.324 73.0991C112.834 82.2357 109.062 90.3161 103.082 97.393C98.6448 102.643 93.3305 106.762 87.2132 109.825C81.846 112.508 76.1512 114.103 70.1712 114.737C65.4697 115.233 60.8315 115.106 56.2884 113.67C56.0137 113.585 55.7495 113.49 55.3586 113.364C55.8129 112.814 56.1827 112.318 56.5948 111.885C59.7432 108.536 62.8811 105.188 66.0613 101.882C66.505 101.417 67.1601 101.122 67.7623 100.836C72.0624 98.7661 76.0033 96.1572 79.6167 93.0518C81.4656 91.4568 83.2723 89.8091 84.9733 88.0557C89.0198 83.8623 92.031 79.0247 93.7848 73.4477C94.3659 71.6098 93.7214 69.7825 92.1894 69.1487C91.4604 68.853 90.6046 68.853 89.7066 68.6945C89.7699 68.5467 89.8545 68.3143 89.9496 68.103C90.6363 66.6137 91.08 65.0821 90.985 63.4133C90.9004 61.8817 90.3193 61.0684 88.8085 60.7198C87.9316 60.5191 87.0124 60.4663 85.9981 60.329C86.0932 60.0438 86.2094 59.7903 86.2728 59.5262C86.4947 58.6812 86.8116 57.8362 86.8645 56.9701C86.9596 55.4913 86.2622 54.6146 84.8465 54.1288C83.4624 53.6534 82.0678 53.7379 80.6732 54.0654C80.3985 54.1288 80.1132 54.2133 79.6906 54.3294C79.7329 53.8541 79.7857 53.495 79.7963 53.1359C79.8174 52.1008 79.8385 51.0762 79.8279 50.0411C79.7857 47.9602 78.4545 46.6293 76.3414 46.4815C74.6509 46.3653 73.0873 46.7667 71.5447 47.4321C69.009 48.52 66.9911 50.3368 64.8674 52.0163C62.2367 54.0971 59.6059 56.1779 57.0174 58.3115C56.3517 58.8714 55.8657 58.7974 55.2318 58.3538C53.3829 57.044 52.2946 55.2906 51.8932 53.0514C51.217 49.2277 50.2555 45.4675 47.9312 42.2881C46.6422 40.5242 45.1631 38.8342 43.5043 37.4188C41.1482 35.4225 37.4398 36.2252 35.4641 38.1476C36.1191 39.0032 36.7319 39.901 37.4504 40.7038C39.1936 42.6895 40.3664 44.9605 41.0954 47.4849C42.3421 51.8261 43.1768 56.2307 43.6416 60.7304C44.0431 64.6491 43.5571 68.5361 43.3353 72.4337C43.1662 75.4862 43.5677 78.4966 44.9623 81.2745C45.3849 82.1195 45.3427 82.6688 44.6348 83.3448C39.3627 88.3726 33.7419 92.9567 27.5929 96.8965C27.0752 97.2345 26.7899 97.2134 26.3567 96.717C20.3873 89.8619 16.7951 81.9294 15.5589 72.9407C13.7945 60.2339 16.1717 48.3933 23.1977 37.5984C27.8253 30.4898 33.9427 24.955 41.4441 20.9201C47.3606 17.7408 53.6682 15.8184 60.3349 15.2163C71.6398 14.2129 82.1629 16.6951 91.7668 22.7791C101.73 29.1061 108.555 37.9258 112.401 49.0587C113.774 53.0197 114.609 57.1074 114.842 61.3113C114.852 61.5437 114.937 61.7655 114.989 61.9979V68.008L115 68.0396Z";

/**
 * `logo`: pin de marca AllRide, con la manita sobre disco blanco.
 * `dot`: pin sobrio con punto, para contextos donde la marca no aplica.
 */
export type MarkerVariant = "logo" | "dot";

export interface MarkerConfig {
  /** Forma del marcador. Por defecto el pin de marca. */
  variant?: MarkerVariant;
  /** Color del cuerpo del pin. */
  color?: string;
  /** Color del interior. */
  dotColor?: string;
  /** Borde exterior: mantiene el pin legible sobre cualquier basemap. */
  outlineColor?: string;
  /** Sombra proyectada en el suelo, para que el pin no se vea pegado. */
  shadow?: boolean;
  /** Animación de caída al aparecer o al reubicarse. */
  animate?: boolean;
  /** [ancho, alto] en px. */
  size?: [number, number];
  /** Punto del ícono que toca la coordenada; por defecto la punta. */
  anchor?: [number, number];
  /**
   * SVG propio. Reemplaza el pin por completo — con esto se puede usar el
   * logo o cualquier marca. Se ignoran color/dotColor/outline.
   */
  html?: string;
}

export const DEFAULT_MARKER = {
  // Celeste AllRide sobre borde blanco: el borde es lo que lo hace visible
  // igual sobre mapa claro, oscuro o una foto satelital.
  variant: "logo" as MarkerVariant,
  color: "#29A8E0",
  dotColor: "#FFFFFF",
  outlineColor: "#FFFFFF",
  shadow: true,
  animate: true,
};

/**
 * El pin con logo es más grande: la manita necesita espacio para leerse,
 * y por debajo de ~40px de alto se convierte en una mancha.
 */
const VARIANT_GEOMETRY: Record<MarkerVariant, { size: [number, number]; anchor: [number, number] }> = {
  logo: { size: [44, 58], anchor: [22, 56] },
  dot: { size: [34, 46], anchor: [17, 44] },
};

export function getMarkerSize(config: MarkerConfig = {}): [number, number] {
  return config.size ?? VARIANT_GEOMETRY[config.variant ?? DEFAULT_MARKER.variant].size;
}

export function getMarkerAnchor(config: MarkerConfig = {}): [number, number] {
  return config.anchor ?? VARIANT_GEOMETRY[config.variant ?? DEFAULT_MARKER.variant].anchor;
}

/** Construye el HTML del marcador (SVG inline) a partir de la config. */
export function buildMarkerHtml(config: MarkerConfig = {}): string {
  if (config.html) return config.html;

  const variant = config.variant ?? DEFAULT_MARKER.variant;
  const color = config.color ?? DEFAULT_MARKER.color;
  const dot = config.dotColor ?? DEFAULT_MARKER.dotColor;
  const outline = config.outlineColor ?? DEFAULT_MARKER.outlineColor;
  const shadow = config.shadow ?? DEFAULT_MARKER.shadow;
  const animate = config.animate ?? DEFAULT_MARKER.animate;
  const [w, h] = getMarkerSize(config);
  const cls = `ari-pin${animate ? " ari-pin-animate" : ""}`;

  if (variant === "dot") {
    return `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg">
    ${shadow ? `<ellipse cx="17" cy="43" rx="6" ry="2.2" fill="rgba(0,0,0,0.28)"/>` : ""}
    <path d="M17 1.5c-7.18 0-13 5.82-13 13 0 8.63 10.6 22.3 12.2 24.3a1 1 0 0 0 1.6 0C19.4 36.8 30 23.13 30 14.5c0-7.18-5.82-13-13-13z"
      fill="${color}" stroke="${outline}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="17" cy="14.5" r="5" fill="${dot}"/>
  </svg>`;
  }

  // Pin de marca: cuerpo celeste, disco blanco y la manita del logo dentro.
  // La transformación lleva el centro del trazado original (65,65 en su
  // viewBox de 130) al centro del disco, escalado para caber con aire.
  return `<svg class="${cls}" width="${w}" height="${h}" viewBox="0 0 44 58" xmlns="http://www.w3.org/2000/svg">
    ${shadow ? `<ellipse cx="22" cy="55" rx="7" ry="2.4" fill="rgba(0,0,0,0.28)"/>` : ""}
    <path d="M22 1.75C11.09 1.75 2.25 10.59 2.25 21.5c0 12.03 16.2 31.44 18.95 34.66a1.05 1.05 0 0 0 1.6 0C25.55 52.94 41.75 33.53 41.75 21.5 41.75 10.59 32.91 1.75 22 1.75z"
      fill="${color}" stroke="${outline}" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="22" cy="21.5" r="12.6" fill="${dot}"/>
    <g transform="translate(22 21.5) scale(0.2) translate(-65 -65)">
      <path d="${ALLRIDE_HAND_PATH}" fill="${color}"/>
    </g>
  </svg>`;
}
