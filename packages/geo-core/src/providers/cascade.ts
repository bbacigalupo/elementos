import type { GeoBias, GeocodeOutcome } from "../types.ts";
import { classifyResult, type ClassifyOptions } from "../batch/classify.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "./types.ts";

/**
 * Proveedor en cascada: prueba cada uno en orden y solo pasa al siguiente
 * si el resultado del anterior no calificó como "ok" — la misma
 * clasificación que ya usa el lote (`classifyResult`) para decidir qué
 * mostrar como incierto, reutilizada acá para decidir cuándo vale la pena
 * seguir preguntando.
 *
 * Pensado para "barrido gratis primero, pagado solo para lo que dejó
 * incierto o fallido" (Bernardo, optimizador de rutas, §11): la mayoría de
 * las direcciones limpias las resuelve bien un proveedor gratuito
 * (`photon`), y el siguiente de la lista (por ejemplo uno pagado) solo se
 * consulta, y solo se cobra, para el resto. Genérico a propósito: no sabe de organizaciones ni
 * de cuotas, eso es política de quien arma la lista de proveedores.
 *
 * Solo cascada `geocode`, que es donde vive el costo de un lote.
 * `autocomplete`/`reverse` son consultas sueltas de la captura individual,
 * no de un lote de miles — delegan siempre al primer proveedor, sin
 * escalar.
 */
export interface CascadeOptions {
  /** Mismo criterio que clasifica el lote — ver `classifyResult`. */
  classify?: ClassifyOptions;
  /**
   * Se llama después de cada intento, escale o no — para medir cuánto se
   * apoya el barrido gratis antes de tocar el pagado (telemetría, no
   * decide nada).
   */
  onStep?: (info: { query: string; providerIndex: number; aceptado: boolean }) => void;
}

export function createCascadingProvider(providers: GeoProvider[], opts: CascadeOptions = {}): GeoProvider {
  if (providers.length === 0) {
    throw new Error("createCascadingProvider necesita al menos un proveedor.");
  }

  async function geocode(query: string, bias: GeoBias, options?: RequestOptions): Promise<GeocodeOutcome | null> {
    let ultimo: GeocodeOutcome | null = null;
    for (let i = 0; i < providers.length; i++) {
      const outcome = await providers[i].geocode(query, bias, options);
      ultimo = outcome;
      const esUltimo = i === providers.length - 1;
      const clasificado = classifyResult(
        { id: "cascada", index: 0, raw: query, query, adminArea: options?.adminArea },
        outcome,
        opts.classify,
      );
      const aceptado = clasificado.status === "ok" || esUltimo;
      opts.onStep?.({ query, providerIndex: i, aceptado });
      if (aceptado) return outcome;
    }
    return ultimo;
  }

  return {
    name: `cascada(${providers.map((p) => p.name).join(" → ")})`,
    capabilities: {
      // Autocomplete y reverse delegan siempre al primero: sus capacidades son las de ese.
      autocomplete: providers[0].capabilities.autocomplete,
      geocode: true,
      reverse: providers[0].capabilities.reverse,
      // Cacheable solo si TODOS los pasos lo son: una consulta cualquiera puede
      // terminar resuelta por cualquiera de ellos, y guardar un resultado de un
      // proveedor que no permite almacenarlo (como Google) rompería su
      // licencia aunque otro paso de la misma cascada sí lo permita.
      cacheable: providers.every((p) => p.capabilities.cacheable !== false),
    },
    geocode,
    // Delegan siempre al primero: ver el comentario de arriba.
    autocomplete: (query: string, bias: GeoBias, options?: AutocompleteOptions) => providers[0].autocomplete(query, bias, options),
    reverse: (lat: number, lng: number, options?: RequestOptions & { lang?: string }) => providers[0].reverse(lat, lng, options),
  };
}
