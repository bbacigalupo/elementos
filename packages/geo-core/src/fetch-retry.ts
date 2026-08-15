/**
 * Fetch con reintentos acotados para los proveedores de geocoding.
 *
 * Los servicios gratuitos (Photon público, tiers free) devuelven 503 o 429
 * de forma intermitente bajo carga. Sin reintento, un tropiezo aislado
 * degrada la captura: el pin se mueve pero la persona ve coordenadas crudas
 * en vez de su dirección.
 *
 * Reintenta solo lo que puede mejorar al repetir —429, 5xx y fallas de
 * red—; un 400 o 404 se devuelve tal cual. Respeta `Retry-After` cuando el
 * servidor lo indica y aborta de inmediato si se cancela la petición.
 */

const RETRIABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Identificación por defecto de los proveedores.
 *
 * No es cortesía: el endpoint `reverse` de Photon responde 503 a TODA
 * petición sin User-Agent, y `fetch` de Node no manda ninguno. Sin esto el
 * reverse geocoding —el que nombra el punto cada vez que alguien mueve el
 * pin— falla siempre desde el servidor. Nominatim además lo exige en sus
 * TOS. Los navegadores ignoran el header (es "forbidden"), así que ponerlo
 * es inocuo en el cliente.
 */
export const DEFAULT_USER_AGENT = "AllRide-Elementos/0.1 (+https://allrideapp.com)";

export interface FetchRetryOptions {
  /** Reintentos adicionales tras el primer intento. */
  retries?: number;
  /** Base de la espera exponencial, en ms. */
  baseDelayMs?: number;
  signal?: AbortSignal;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Espera indicada por el servidor en `Retry-After` (segundos o fecha). */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: FetchRetryOptions = {},
): Promise<Response> {
  const { retries = 2, baseDelayMs = 300, signal } = options;
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // Backoff exponencial con jitter, para no sincronizar reintentos de
      // varias personas contra un proveedor que ya viene cargado.
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      await delay(backoff + Math.random() * baseDelayMs, signal);
    }

    try {
      const response = await fetch(url, init);
      if (!RETRIABLE_STATUS.has(response.status) || attempt === retries) return response;

      const serverWait = retryAfterMs(response);
      // Un Retry-After largo significa que insistir no va a ayudar dentro de
      // lo que alguien está dispuesto a esperar.
      if (serverWait !== null) {
        if (serverWait > 3000) return response;
        await delay(serverWait, signal);
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (attempt === retries) throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("fetch falló tras reintentos");
}
