import { createProvider, createGeoHandlers, createDailyQuota, type GeoHandlers } from "@bbacigalupo/geo-core";

/**
 * Construcción única del backend, compartida entre `api/geo.ts` (la ruta
 * exacta `/api/geo`) y `api/geo/[...path].ts` (`/api/geo/autocomplete`,
 * `/geocode`, `/reverse`, `/quota`) — dos archivos porque así enruta Vercel
 * sin framework, pero un solo `GeoHandlers`, para que la caché, el
 * cortacircuitos, el rate limiter y la cuota diaria sean el mismo estado en
 * memoria y no cuatro copias que no se enteran unas de otras.
 *
 * **Límite conocido, heredado de `createGeoHandlers`/`createDailyQuota`**:
 * viven en memoria del proceso — en Vercel cada instancia (y cada región)
 * tiene la suya, así que el tope real es `DAILY_QUOTA × instancias frías
 * activas`, no `DAILY_QUOTA` a secas. Aceptable para arrancar; si el
 * volumen lo justifica, reemplazar por un contador compartido (Vercel KV,
 * Upstash Redis) — ver el mismo aviso en `geo-core/README.md`.
 */

const ORIGIN = process.env.ALLOWED_ORIGIN;
if (!ORIGIN) {
  throw new Error(
    "Falta ALLOWED_ORIGIN (el dominio de WordPress, ej. https://allrideapp.com). Sin esto cualquier sitio podría gastar la cuota.",
  );
}

const LOCATIONIQ_KEY = process.env.LOCATIONIQ_KEY;
if (!LOCATIONIQ_KEY) {
  throw new Error("Falta LOCATIONIQ_KEY.");
}

const DAILY_QUOTA = Number(process.env.DAILY_QUOTA ?? 450);

const provider = createProvider({
  name: "locationiq",
  apiKey: LOCATIONIQ_KEY,
  cache: { ttlMs: 12 * 60 * 60 * 1000, maxEntries: 5000 },
  circuitBreaker: { failureThreshold: 5, resetMs: 30_000 },
});

export const handlers: GeoHandlers = createGeoHandlers({
  provider,
  cors: ORIGIN.split(",").map((o) => o.trim()),
  dailyQuota: createDailyQuota(DAILY_QUOTA),
});
