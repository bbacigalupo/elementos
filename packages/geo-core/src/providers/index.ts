import { withCache, type GeoCacheOptions } from "../cache.ts";
import { withCircuitBreaker, type CircuitBreakerOptions } from "../circuit-breaker.ts";
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
  /**
   * Caché compartida de resultados. Viene activada: es lo que evita pagar
   * (o gastar cuota) varias veces por la misma dirección. `false` la apaga.
   */
  cache?: GeoCacheOptions | false;
  /**
   * Cortacircuitos ante caídas del proveedor. Viene activado: sin él, una
   * caída se amplifica por los reintentos. `false` lo apaga.
   */
  circuitBreaker?: CircuitBreakerOptions | false;
}

/**
 * Fábrica de proveedores por configuración.
 *
 * Devuelve el proveedor ya protegido: caché compartida (menos llamadas y
 * menos costo) y cortacircuitos (no golpear a un proveedor caído). Las
 * protecciones vienen puestas a propósito — quien integra el elemento no
 * debería tener que acordarse de activarlas para que su despliegue esté
 * sano.
 */
export function createProvider(config: ProviderConfig): GeoProvider {
  let provider = createBaseProvider(config);
  if (config.circuitBreaker !== false) {
    provider = withCircuitBreaker(provider, config.circuitBreaker ?? {});
  }
  if (config.cache !== false) {
    provider = withCache(provider, config.cache ?? {});
  }
  return provider;
}

/** El proveedor "desnudo", sin caché ni cortacircuitos. */
export function createBaseProvider(config: ProviderConfig): GeoProvider {
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
