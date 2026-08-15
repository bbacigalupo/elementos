/**
 * Tipos compartidos de captura de ubicación.
 *
 * `LocationValue` es el contrato de salida de todo el sistema: cualquier
 * interfaz que capture una dirección (encuesta, origen/destino de viaje,
 * etc.) recibe esta misma estructura, sin importar el proveedor usado.
 */

/** Calidad de la coordenada obtenida. */
export type Precision =
  | "rooftop" // dirección exacta (calle + número)
  | "street" // la calle, sin número exacto
  | "zone" // centro de comuna/ciudad/zona
  | "exact"; // coordenadas ingresadas directamente por la persona

/** Cómo se originó el punto. */
export type LocationSource = "autocomplete" | "search" | "pin" | "gps" | "coords";

export interface AddressComponents {
  street: string | null;
  number: string | null;
  sublocality: string | null;
  commune: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  /** ISO-3166-1 alpha-2, ej. "CL". */
  country: string | null;
}

export interface LocationValue {
  lat: number;
  lng: number;
  /** Dirección legible, formateada con un estándar único. */
  formatted: string;
  components: AddressComponents;
  /** Identificador del lugar en el proveedor (osm_id, place_id de Google…). */
  placeId?: string;
  precision: Precision;
  source: LocationSource;
  /** Proveedor que resolvió la dirección: "photon", "locationiq", "nominatim", "google"… */
  provider: string;
  /** ISO 8601. */
  capturedAt: string;
}

/**
 * Acotamiento de búsqueda por zona. `country` es filtro duro (excluye
 * resultados de otros países); `center`/`radiusKm` son bias blando
 * (priorizan lo cercano sin excluir lo lejano).
 */
export interface GeoBias {
  /** ISO-3166-1 alpha-2, ej. "CL". Obligatorio: elimina la mayoría del ruido. */
  country: string;
  center?: { lat: number; lng: number };
  radiusKm?: number;
  /** Idioma preferido para resultados, si el proveedor lo soporta. */
  lang?: string;
}

/** Nivel real que logró el geocoder; si es "zone" la UI debe pedir ajustar el pin. */
export type MatchedLevel = "address" | "street" | "zone";

/**
 * División administrativa declarada por la persona (comuna, municipio,
 * distrito…). Sirve para acotar la búsqueda y, sobre todo, para mandar
 * sobre lo que parsee el geocoder: en Chile los datos OSM devuelven
 * "Santiago" como comuna para direcciones que están en Peñalolén, y esa
 * variable suele ser clave para el análisis posterior.
 */
export interface AdminAreaOption {
  id: string;
  /** Nombre de la división, ej. "Peñalolén". */
  name: string;
  /** División superior, ej. "Región Metropolitana de Santiago". */
  parentName?: string;
  /** Centro conocido; si está, afina el bias al elegirla. */
  center?: { lat: number; lng: number };
  radiusKm?: number;
}

/**
 * Orden de calidad para comparar contra un mínimo exigido. Las coordenadas
 * ingresadas a mano cuentan como máxima precisión: quien las escribe está
 * declarando un punto exacto a propósito.
 */
const PRECISION_RANK: Record<Precision, number> = { zone: 1, street: 2, rooftop: 3, exact: 3 };

export function precisionMeets(actual: Precision, minimum: Precision): boolean {
  return PRECISION_RANK[actual] >= PRECISION_RANK[minimum];
}

export interface GeocodeOutcome {
  value: LocationValue;
  matchedLevel: MatchedLevel;
}

/** Sugerencia de autocompletado. Trae el `LocationValue` completo para que
 * seleccionarla no requiera otra llamada al proveedor. */
export interface Suggestion {
  id: string;
  label: string;
  sublabel: string;
  value: LocationValue;
}

/** Métricas de una captura, para análisis de calidad del flujo. */
export interface CaptureMetrics {
  startedAt: number;
  confirmedAt: number;
  secondsToConfirm: number;
  pinMovedMeters: number;
  usedGps: boolean;
  usedMapOnly: boolean;
  usedCoords: boolean;
  matchedLevel: MatchedLevel | null;
  finalPrecision: Precision;
  /** true si el mapa visual no cargó y la persona confirmó solo con texto. */
  mapFailed: boolean;
  /**
   * true si se confirmó por debajo de la precisión mínima pedida. No
   * bloquea la captura —nunca dejar a alguien atrapado— pero deja el dato
   * marcado para el análisis.
   */
  belowMinPrecision: boolean;
  /** true si la división administrativa la declaró la persona, no el geocoder. */
  adminAreaDeclared: boolean;
}

// ---------- utilidades geométricas ----------

export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Formatea componentes con el estándar único: "Calle Número, Comuna, Región, País". */
export function formatAddress(c: AddressComponents, fallback = ""): string {
  const line1 = [c.street, c.number].filter(Boolean).join(" ");
  const parts = [line1 || null, c.commune ?? c.city, c.region, c.country].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : fallback;
}
