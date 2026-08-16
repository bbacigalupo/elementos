import { canonicalAdminArea, hasAdminCatalog } from "../admin/index.ts";
import { normalizeTokens } from "../relevance.ts";
import {
  formatAddress,
  type AddressComponents,
  type GeocodeOutcome,
  type LocationValue,
  type MatchedLevel,
  type Precision,
} from "../types.ts";

/**
 * Mapeo compartido para proveedores basados en datos OSM con formato
 * Nominatim (Nominatim público y LocationIQ responden igual).
 */

export interface OsmAddress {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  neighbourhood?: string;
  /** Barrio dentro de una comuna, o la comuna misma en el Gran Santiago. */
  quarter?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  county?: string;
  state?: string;
  region?: string;
  postcode?: string;
  country_code?: string;
}

export interface OsmResult {
  place_id?: string | number;
  osm_type?: string;
  osm_id?: string | number;
  lat: string;
  lon: string;
  display_name: string;
  address?: OsmAddress;
}

/**
 * Campos donde OSM puede esconder la división administrativa, del más
 * específico al más general. El orden importa solo cuando más de uno
 * contiene una división válida: en el Gran Santiago `suburb` y `city`
 * pueden serlo a la vez ("Providencia" en ambos) y gana el específico.
 */
const ADMIN_KEYS = [
  "suburb",
  "city",
  "town",
  "municipality",
  "village",
  "quarter",
  "neighbourhood",
] as const satisfies readonly (keyof OsmAddress)[];

/**
 * La comuna (o su equivalente en el país), en la grafía oficial.
 *
 * Con catálogo del país se elige el primer campo cuyo valor **sea** una
 * división administrativa real. Sin catálogo se cae a la regla de siempre,
 * que acierta donde `city` es la comuna y falla donde no — que era el
 * comportamiento anterior para todos los países.
 *
 * Se devuelve el nombre del catálogo y no el de OSM: los datos de OSM los
 * edita cualquiera y la misma comuna aparece escrita de varias formas
 * ("Ñuñoa" y "Nuñoa" conviven). Normalizar acá deja la columna Comuna del
 * export lista para filtrar y para sumar por comuna.
 */
function pickCommune(a: OsmAddress): string | null {
  const country = a.country_code?.toUpperCase() ?? null;
  if (hasAdminCatalog(country)) {
    for (const key of ADMIN_KEYS) {
      const oficial = canonicalAdminArea(country, a[key]);
      if (oficial) return oficial;
    }
  }
  return a.city ?? a.town ?? a.municipality ?? a.village ?? null;
}

export function mapOsmComponents(a: OsmAddress): AddressComponents {
  const commune = pickCommune(a);
  /*
   * El barrio no repite a la comuna. Cuando la comuna vino de `suburb` —el
   * caso del Gran Santiago— usar ese mismo campo como barrio dejaba
   * "Las Condes" en las dos columnas y no aportaba nada. La comparación es
   * normalizada porque `commune` ya viene en la grafía del catálogo y el
   * campo de OSM puede diferir en una tilde.
   */
  const esLaComuna = (v: string | undefined): boolean =>
    Boolean(v) && (v === commune || normalizeTokens(v!).join(" ") === normalizeTokens(commune ?? "").join(" "));
  const barrio = [a.neighbourhood, a.quarter, a.suburb].find((v) => v && !esLaComuna(v)) ?? null;

  return {
    street: a.road ?? a.pedestrian ?? null,
    number: a.house_number ?? null,
    sublocality: barrio,
    commune,
    // La ciudad se mantiene como lo que OSM dice que es: en Santiago,
    // "Santiago" para toda la conurbación. No es un error — es otro nivel,
    // y tenerlo aparte de la comuna es justamente lo que faltaba.
    city: a.city ?? a.town ?? null,
    region: a.state ?? a.region ?? null,
    postalCode: a.postcode ?? null,
    country: a.country_code ? a.country_code.toUpperCase() : null,
  };
}

export function osmPrecision(a: OsmAddress | undefined): Precision {
  if (a?.house_number) return "rooftop";
  if (a?.road || a?.pedestrian) return "street";
  return "zone";
}

export function precisionToMatchedLevel(p: Precision): MatchedLevel {
  if (p === "rooftop" || p === "exact") return "address";
  if (p === "street") return "street";
  return "zone";
}

export function osmToLocationValue(r: OsmResult, provider: string): LocationValue {
  const components = mapOsmComponents(r.address ?? {});
  return {
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    formatted: formatAddress(components, r.display_name),
    components,
    placeId: r.osm_id != null ? `${r.osm_type ?? "osm"}:${r.osm_id}` : undefined,
    precision: osmPrecision(r.address),
    source: "search",
    provider,
    capturedAt: new Date().toISOString(),
  };
}

export function osmToOutcome(r: OsmResult, provider: string): GeocodeOutcome {
  const value = osmToLocationValue(r, provider);
  return { value, matchedLevel: precisionToMatchedLevel(value.precision) };
}

/** viewbox `izq,arriba,der,abajo` para bias por centro+radio (Nominatim/LocationIQ). */
export function viewboxFor(center: { lat: number; lng: number }, radiusKm: number): string {
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  return [center.lng - dLng, center.lat + dLat, center.lng + dLng, center.lat - dLat].join(",");
}
