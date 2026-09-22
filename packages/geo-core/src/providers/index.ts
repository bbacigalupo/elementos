import { withCache, type GeoCacheOptions } from "../cache.ts";
import { withCircuitBreaker, type CircuitBreakerOptions } from "../circuit-breaker.ts";
import { createCascadingProvider, type CascadeOptions } from "./cascade.ts";
import { createLocationIqProvider } from "./locationiq.ts";
import { createMapboxProvider } from "./mapbox.ts";
import { createNominatimProvider } from "./nominatim.ts";
import { createPhotonProvider } from "./photon.ts";
import type { GeoProvider } from "./types.ts";

export type ProviderName = "photon" | "nominatim" | "locationiq" | "mapbox" | "google";

export interface ProviderConfig {
  name: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  userAgent?: string;
  /**
   * Mapbox solo: ver la nota de `mapbox.ts` antes de tocar esto. `false`
   * (temporal, gratis, sin almacenamiento) por omisión.
   */
  mapboxPermanent?: boolean;
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

/**
 * Cascada armada directo desde configuración: cada paso pasa por
 * `createProvider` (así cada uno lleva su propia caché/cortacircuitos, no
 * uno compartido para toda la cascada) y se encadenan en el orden dado. Es
 * el punto de entrada que usa quien solo quiere "gratis primero, pagado
 * para lo que quede" sin armar la cascada a mano.
 */
export function createCascadeFromConfigs(configs: ProviderConfig[], cascadeOpts?: CascadeOptions): GeoProvider {
  return createCascadingProvider(configs.map((c) => createProvider(c)), cascadeOpts);
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
    case "mapbox":
      return createMapboxProvider({
        accessToken: config.apiKey ?? "",
        baseUrl: config.baseUrl,
        userAgent: config.userAgent,
        permanent: config.mapboxPermanent,
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

export { createCascadingProvider, createLocationIqProvider, createMapboxProvider, createNominatimProvider, createPhotonProvider };
export type { CascadeOptions, GeoProvider };
