import type { GeoBias, GeocodeOutcome, LocationValue, Suggestion } from "../types.ts";
import type { AutocompleteOptions, GeoProvider, RequestOptions } from "../providers/types.ts";

/**
 * `GeoClient` es lo único que la UI conoce: la misma interfaz que un
 * proveedor, sin importar el transporte.
 *
 * - `directClient(provider)`: llama al proveedor directo desde el
 *   navegador. Sirve para demos/prototipos con proveedores sin key
 *   (Photon soporta CORS). NUNCA para proveedores con API key.
 * - `httpClient(baseUrl)`: habla con un backend propio que implemente el
 *   contrato HTTP (ver http/handlers.ts). Es el modo de producción: la key
 *   vive en el servidor, se puede cachear y aplicar rate limiting.
 */
export type GeoClient = Pick<GeoProvider, "autocomplete" | "geocode" | "reverse"> & {
  /**
   * Cuánta cuota diaria propia queda, si el transporte la conoce.
   *
   * Solo `httpClient` la implementa: es el único lado que puede saber
   * cuánto se ha gastado de la cuenta real con el proveedor. El modo
   * directo no tiene noción de "propio" — cada pestaña vería su propio
   * conteo en memoria, que no sirve de nada.
   */
  quota?: (signal?: AbortSignal) => Promise<QuotaStatus>;
};

export interface QuotaStatus {
  /** false si el backend no tiene tope propio configurado (o no expone `/quota`). */
  configured: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  resetsAt?: string;
}

export function directClient(provider: GeoProvider): GeoClient {
  return provider;
}

interface HttpEnvelope<T> {
  ok: boolean;
  error?: string;
  suggestions?: Suggestion[];
  outcome?: T;
  value?: LocationValue | null;
}

function areaParams(url: URL, opts?: { adminArea?: { name: string; parentName?: string } }) {
  if (!opts?.adminArea) return;
  url.searchParams.set("area", opts.adminArea.name);
  if (opts.adminArea.parentName) url.searchParams.set("areaParent", opts.adminArea.parentName);
}

function biasParams(url: URL, bias: GeoBias) {
  url.searchParams.set("country", bias.country);
  if (bias.center) {
    url.searchParams.set("lat", String(bias.center.lat));
    url.searchParams.set("lng", String(bias.center.lng));
  }
  if (bias.radiusKm != null) url.searchParams.set("radiusKm", String(bias.radiusKm));
  if (bias.lang) url.searchParams.set("lang", bias.lang);
}

export function httpClient(baseUrl: string): GeoClient {
  const base = baseUrl.replace(/\/$/, "");

  async function call<T>(url: URL, signal?: AbortSignal): Promise<HttpEnvelope<T>> {
    const res = await fetch(url, { signal });
    const body = (await res.json().catch(() => null)) as HttpEnvelope<T> | null;
    if (!res.ok || !body?.ok) {
      throw new Error(body?.error ?? `El servicio de direcciones respondió ${res.status}`);
    }
    return body;
  }

  return {
    async autocomplete(query, bias, opts?: AutocompleteOptions): Promise<Suggestion[]> {
      const url = new URL(`${base}/autocomplete`, globalThis.location?.href);
      url.searchParams.set("q", query);
      if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
      biasParams(url, bias);
      areaParams(url, opts);
      const body = await call<never>(url, opts?.signal);
      return body.suggestions ?? [];
    },

    async geocode(query, bias, opts?: RequestOptions): Promise<GeocodeOutcome | null> {
      const url = new URL(`${base}/geocode`, globalThis.location?.href);
      url.searchParams.set("q", query);
      biasParams(url, bias);
      areaParams(url, opts);
      const body = await call<GeocodeOutcome | null>(url, opts?.signal);
      return body.outcome ?? null;
    },

    async reverse(lat, lng, opts): Promise<LocationValue | null> {
      const url = new URL(`${base}/reverse`, globalThis.location?.href);
      url.searchParams.set("lat", String(lat));
      url.searchParams.set("lng", String(lng));
      if (opts?.lang) url.searchParams.set("lang", opts.lang);
      const body = await call<never>(url, opts?.signal);
      return body.value ?? null;
    },

    async quota(signal?: AbortSignal): Promise<QuotaStatus> {
      try {
        const url = new URL(`${base}/quota`, globalThis.location?.href);
        const res = await fetch(url, { signal });
        // Un backend viejo sin esta ruta no es un error: el aviso previo es
        // una mejora opcional, nunca un requisito para poder procesar.
        if (!res.ok) return { configured: false };
        const body = (await res.json().catch(() => null)) as (QuotaStatus & { ok?: boolean }) | null;
        return body?.ok ? body : { configured: false };
      } catch {
        return { configured: false };
      }
    },
  };
}
