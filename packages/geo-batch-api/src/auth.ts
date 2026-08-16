import type { ApiKeyRecord, ApiScope } from "./types.ts";
import type { BatchStore } from "./store.ts";
import { hashApiKey, looksLikeApiKey, timingSafeEqual } from "./keys.ts";

/**
 * Autenticación por API key, con aislamiento por cliente.
 *
 * Toda la API se apoya en una sola garantía: **de acá para adentro, nada
 * conoce un `tenantId` que no haya salido de una clave válida.** Ningún
 * handler de los pasos siguientes recibe el `tenantId` de un parámetro de
 * la URL o del cuerpo de la petición — lo único confiable es lo que devuelve
 * `authenticate()`, y `BatchStore` ya obliga por firma a que ese id viaje en
 * cada lectura (ver store.ts). Esta función es dónde arranca esa cadena.
 */

export interface AuthContext {
  tenantId: string;
  key: ApiKeyRecord;
}

export type AuthError =
  /** Sin encabezado `Authorization`, o sin el esquema `Bearer`. */
  | { code: "missing_key"; status: 401 }
  /** Trae algo, pero no tiene la forma de una clave nuestra. */
  | { code: "malformed_key"; status: 401 }
  /** Tiene la forma correcta, pero no existe (o el hash no calza). */
  | { code: "invalid_key"; status: 401 }
  /** Existe, pero fue revocada. */
  | { code: "revoked_key"; status: 401 }
  /** Válida, pero no le alcanza el permiso para esta acción. */
  | { code: "insufficient_scope"; status: 403; required: ApiScope };

export type AuthOutcome = { ok: true; context: AuthContext } | { ok: false; error: AuthError };

/** El texto que le corresponde a cada error, para responder `{ error: string }`. */
export const AUTH_ERROR_TEXT: Record<AuthError["code"], string> = {
  missing_key: "missing_api_key",
  malformed_key: "malformed_api_key",
  invalid_key: "invalid_api_key",
  revoked_key: "revoked_api_key",
  insufficient_scope: "insufficient_scope",
};

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ", 2);
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
}

/**
 * Resuelve la clave de una petición y valida que pueda hacer lo que pide.
 *
 * El orden de los chequeos importa para no filtrar información de más: se
 * rechaza por forma antes de tocar el store (evita una consulta por cada
 * basura que llegue), y se revisa revocación antes que alcance — una clave
 * revocada nunca debería decir "te falta permiso", que insinúa que con el
 * scope correcto funcionaría.
 */
export async function authenticate(
  req: Request,
  store: BatchStore,
  opts: { scope?: ApiScope; now?: Date } = {},
): Promise<AuthOutcome> {
  const token = bearerToken(req);
  if (!token) return { ok: false, error: { code: "missing_key", status: 401 } };
  if (!looksLikeApiKey(token)) return { ok: false, error: { code: "malformed_key", status: 401 } };

  const hash = await hashApiKey(token);
  const key = await store.findApiKeyByHash(hash);
  // Re-verificar en tiempo constante y no confiar solo en la comparación
  // interna del store: es gratis y cierra la puerta a implementaciones que
  // busquen por prefijo o índice parcial.
  if (!key || !timingSafeEqual(key.keyHash, hash)) {
    return { ok: false, error: { code: "invalid_key", status: 401 } };
  }
  if (key.revokedAt) return { ok: false, error: { code: "revoked_key", status: 401 } };
  if (opts.scope && !key.scopes.includes(opts.scope)) {
    return { ok: false, error: { code: "insufficient_scope", status: 403, required: opts.scope } };
  }

  await store.touchApiKey(key.id, opts.now ?? new Date());
  return { ok: true, context: { tenantId: key.tenantId, key } };
}

// ---------- cuota diaria del cliente ----------

export interface QuotaStatus {
  /** `null` = sin tope (clave interna). */
  limit: number | null;
  used: number;
  /** `null` cuando `limit` es `null`. */
  remaining: number | null;
  /** ISO 8601 de cuándo se repone (medianoche UTC). `null` cuando `limit` es `null`. */
  resetsAt: string | null;
}

/**
 * Cuánto lleva gastado el cliente hoy contra su tope.
 *
 * Vive acá y no en `authenticate()` porque no toda llamada autenticada debe
 * frenarse por cuota — listar trabajos o consultar uno no gasta cuota
 * nueva, y bloquear esa lectura porque el cliente ya gastó su cupo de hoy
 * le escondería justo la información que necesita para decidir qué hacer.
 * Quien cree un trabajo nuevo (paso siguiente) es quien debe llamar a esto.
 */
export async function quotaStatus(store: BatchStore, key: ApiKeyRecord, now: Date): Promise<QuotaStatus> {
  if (key.dailyQuota === null) return { limit: null, used: 0, remaining: null, resetsAt: null };
  const desde = new Date(now);
  desde.setUTCHours(0, 0, 0, 0);
  const used = await store.usageSince(key.tenantId, desde);
  const resetsAt = new Date(desde);
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1);
  return {
    limit: key.dailyQuota,
    used,
    remaining: Math.max(0, key.dailyQuota - used),
    resetsAt: resetsAt.toISOString(),
  };
}
