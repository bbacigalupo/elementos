import type { GeoBias, GeocodeOutcome, LocationValue, Suggestion } from "../types.ts";

export interface RequestOptions {
  signal?: AbortSignal;
  /**
   * División administrativa declarada por la persona. Viaja como dato
   * estructurado, no concatenada al texto: los geocoders resuelven mucho
   * mejor "calle + número" cuando la comuna va en su propio campo, y
   * pegarla al query degrada los resultados (LocationIQ devolvía otra calle
   * con el mismo número).
   */
  adminArea?: { name: string; parentName?: string };
}

export interface AutocompleteOptions extends RequestOptions {
  limit?: number;
}

/**
 * Interfaz única de proveedores de geocoding. Cada proveedor (gratuito o
 * pagado) es un adapter de esta interfaz; la UI y los handlers HTTP no
 * saben cuál hay detrás. Para agregar Google Places más adelante basta un
 * archivo nuevo que la implemente.
 */
export interface GeoProvider {
  name: string;
  capabilities: {
    /** Sugerencias tecla a tecla. Si es false, la UI solo ofrece búsqueda explícita. */
    autocomplete: boolean;
    geocode: boolean;
    reverse: boolean;
    /**
     * ¿Se pueden almacenar sus resultados? Los proveedores OSM (ODbL) sí;
     * Google restringe el cacheo por contrato. `withCache` lo respeta.
     * Por defecto se asume que sí.
     */
    cacheable?: boolean;
  };
  autocomplete(query: string, bias: GeoBias, opts?: AutocompleteOptions): Promise<Suggestion[]>;
  geocode(query: string, bias: GeoBias, opts?: RequestOptions): Promise<GeocodeOutcome | null>;
  reverse(lat: number, lng: number, opts?: RequestOptions & { lang?: string }): Promise<LocationValue | null>;
}
