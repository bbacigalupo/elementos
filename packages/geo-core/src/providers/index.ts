import { createLocationIqProvider } from "./locationiq.ts";
import { createNominatimProvider } from "./nominatim.ts";
import { createPhotonProvider } from "./photon.ts";
import type { GeoProvider } from "./types.ts";

export type ProviderName = "photon" | "nominatim" | "locationiq" | "google";

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
}

/** Fábrica de proveedores por configuración. */
export function createProvider(config: ProviderConfig): GeoProvider {
  switch (config.name) {
    case "photon":
      return createPhotonProvider({ baseUrl: config.baseUrl, userAgent: config.userAgent });
    case "nominatim":
      return createNominatimProvider({ baseUrl: config.baseUrl, userAgent: config.userAgent });
    case "locationiq":
      return createLocationIqProvider({
        apiKey: config.apiKey ?? "",
        baseUrl: config.baseUrl,
        userAgent: config.userAgent,
      });
    case "google":
      // Planificado: Google Places (New) con session tokens. La interfaz
      // GeoProvider ya contempla todo lo necesario (autocomplete/geocode/
      // reverse + placeId); solo falta el adapter.
      throw new Error("El adapter de Google Places aún no está implementado (planificado).");
    default:
      throw new Error(`Proveedor desconocido: ${String((config as ProviderConfig).name)}`);
  }
}

export { createLocationIqProvider, createNominatimProvider, createPhotonProvider };
export type { GeoProvider };
