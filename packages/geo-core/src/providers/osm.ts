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

export function mapOsmComponents(a: OsmAddress): AddressComponents {
  return {
    street: a.road ?? a.pedestrian ?? null,
    number: a.house_number ?? null,
    sublocality: a.neighbourhood ?? a.suburb ?? null,
    // En OSM Chile la comuna aparece según el tamaño de la localidad como
    // city/town/municipality/village; county suele ser la provincia.
    commune: a.city ?? a.town ?? a.municipality ?? a.village ?? null,
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
