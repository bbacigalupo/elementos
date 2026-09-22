import {
  createProvider,
  createGeoHandlers,
  createDailyQuota,
  type GeoHandlers,
  type ProviderName,
} from "@bbacigalupo/geo-core";

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

const DAILY_QUOTA = Number(process.env.DAILY_QUOTA ?? 450);

const SHARED_PROTECTION = {
  cache: { ttlMs: 12 * 60 * 60 * 1000, maxEntries: 5000 },
  circuitBreaker: { failureThreshold: 5, resetMs: 30_000 },
};

/**
 * Proveedor seleccionable por variable de entorno (Vercel → Settings →
 * Environment Variables), mismo patrón que ya usa el playground
 * (`demo/vite.config.ts`, `GEO_PROVIDER`) — así activar Mapbox el día que
 * haya credenciales de pago es cambiar variables y redesplegar, nunca
 * tocar código. Por omisión sigue en LocationIQ, que es lo que corre en
 * producción hoy; sin `GEO_PROVIDER` puesto, este archivo se comporta
 * exactamente igual que antes (22 sept 2026).
 *
 * `MAPBOX_PERMANENT=true` habilita el modo "Permanent Geocoding" de Mapbox
 * (permite guardar resultados; USD 5/1.000 consultas, requiere que la
 * cuenta de Mapbox tenga el plan pagado activado). **No poner esta
 * variable en `true` sin haber confirmado que esa cuenta ya tiene el plan
 * — ver la nota completa en `geo-core/src/providers/mapbox.ts`.** Sin
 * ella, o en `false`, Mapbox queda en modo temporal (gratis, resultados de
 * solo pantalla) y este backend NUNCA los cachea: `withCache` respeta
 * `capabilities.cacheable`, que `mapbox.ts` apaga mientras siga en modo
 * temporal, así que la config de caché de abajo es un no-op seguro en ese
 * caso.
 */
function resolveProvider() {
  const name = (process.env.GEO_PROVIDER || "locationiq") as ProviderName;

  if (name === "mapbox") {
    const token = process.env.MAPBOX_TOKEN;
    if (!token) throw new Error("GEO_PROVIDER=mapbox pero falta MAPBOX_TOKEN.");
    return createProvider({
      name: "mapbox",
      apiKey: token,
      mapboxPermanent: process.env.MAPBOX_PERMANENT === "true",
      ...SHARED_PROTECTION,
    });
  }

  const key = process.env.LOCATIONIQ_KEY;
  if (!key) throw new Error("Falta LOCATIONIQ_KEY.");
  return createProvider({ name: "locationiq", apiKey: key, ...SHARED_PROTECTION });
}

export const handlers: GeoHandlers = createGeoHandlers({
  provider: resolveProvider(),
  cors: ORIGIN.split(",").map((o) => o.trim()),
  dailyQuota: createDailyQuota(DAILY_QUOTA),
});
