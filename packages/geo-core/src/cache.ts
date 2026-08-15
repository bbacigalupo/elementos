import type { GeoBias, LocationValue } from "./types.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./providers/types.ts";

/**
 * Caché en memoria + fusión de peticiones idénticas en vuelo.
 *
 * Es la medida que más reduce el consumo del proveedor: en una encuesta
 * mucha gente escribe las mismas calles de la misma comuna, y sin caché
 * cada tecleo de cada persona es una llamada pagada. Además protege contra
 * el abuso más simple —repetir la misma consulta en bucle—, que con caché
 * cuesta lo mismo que una sola.
 *
 * Vive del lado servidor, detrás del proxy: es compartida entre todas las
 * personas que responden, no por navegador.
 *
 * IMPORTANTE — legal: los proveedores basados en OSM (Photon, LocationIQ,
 * Nominatim) permiten almacenar resultados; Google Places NO permite
 * cachearlos más allá de lo que fija su contrato. Por eso el envoltorio
 * respeta `capabilities.cacheable` y no cachea a quien lo declare false.
 */

export interface GeoCacheOptions {
  /** Entradas máximas antes de descartar las menos usadas. */
  maxEntries?: number;
  /** Vida de cada entrada. Las direcciones cambian poco: 24 h por defecto. */
  ttlMs?: number;
  /**
   * Decimales al redondear coordenadas en la clave del reverse. 4 ≈ 11 m:
   * arrastrar el pin unos metros reutiliza la misma respuesta.
   */
  reversePrecision?: number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** LRU con expiración. Map de JS conserva el orden de inserción, que es lo
 * que se usa para descartar la entrada más antigua. */
class LruCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Releer la marca como uso reciente.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.entries.size;
  }
}

function biasKey(bias: GeoBias): string {
  return [
    bias.country.toUpperCase(),
    bias.center ? `${bias.center.lat.toFixed(3)},${bias.center.lng.toFixed(3)}` : "",
    bias.radiusKm ?? "",
    bias.lang ?? "",
  ].join("|");
}

function areaKey(opts?: RequestOptions): string {
  const a = opts?.adminArea;
  return a ? `${a.name}|${a.parentName ?? ""}` : "";
}

function normalizeQuery(query: string): string {
  // Mismo texto con distinto espaciado o capitalización = misma consulta.
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Envuelve un proveedor con caché y fusión de peticiones en vuelo.
 *
 * La fusión evita el caso clásico de "estampida": si veinte personas piden
 * la misma dirección en el mismo segundo, sale una sola llamada al
 * proveedor y las veinte reciben su resultado.
 */
export function withCache(provider: GeoProvider, options: GeoCacheOptions = {}): GeoProvider {
  if (provider.capabilities.cacheable === false) return provider;

  const {
    maxEntries = 1000,
    ttlMs = 24 * 60 * 60 * 1000,
    reversePrecision = 4,
  } = options;

  const cache = new LruCache<unknown>(maxEntries, ttlMs);
  const inflight = new Map<string, Promise<unknown>>();

  /**
   * La petición compartida no recibe el `signal` de quien la pidió: si el
   * primero cancela, los demás perderían un resultado que ya venía en
   * camino. Cancelar solo ahorra ancho de banda; acá el resultado además
   * llena la caché, así que dejarlo terminar es lo correcto.
   */
  async function resolve<T>(key: string, run: () => Promise<T>): Promise<T> {
    const cached = cache.get(key);
    if (cached !== undefined) return cached as T;

    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = run()
      .then((result) => {
        // Solo se guardan respuestas útiles: un "no encontrado" puede ser un
        // fallo transitorio del proveedor y no conviene fijarlo 24 horas.
        if (result !== null && !(Array.isArray(result) && result.length === 0)) {
          cache.set(key, result);
        }
        return result;
      })
      .finally(() => inflight.delete(key));

    inflight.set(key, promise);
    return promise;
  }

  return {
    ...provider,
    autocomplete(query, bias, opts?: AutocompleteOptions) {
      const key = `ac|${provider.name}|${normalizeQuery(query)}|${biasKey(bias)}|${areaKey(opts)}|${opts?.limit ?? 5}`;
      return resolve(key, () => provider.autocomplete(query, bias, opts));
    },
    geocode(query, bias, opts?: RequestOptions) {
      const key = `gc|${provider.name}|${normalizeQuery(query)}|${biasKey(bias)}|${areaKey(opts)}`;
      return resolve(key, () => provider.geocode(query, bias, opts));
    },
    async reverse(lat, lng, opts) {
      const key = `rv|${provider.name}|${lat.toFixed(reversePrecision)},${lng.toFixed(reversePrecision)}|${opts?.lang ?? ""}`;
      const value = await resolve<LocationValue | null>(key, () => provider.reverse(lat, lng, opts));
      // La clave está redondeada: el punto devuelto debe ser el que se pidió,
      // no el del vecino que llenó la caché.
      return value ? { ...value, lat, lng } : null;
    },
  };
}
