import { timingSafeEqual } from "./keys.ts";

/**
 * Links firmados de corrección: la manera de que una persona sin clave de
 * API corrija UNA fila incierta abriendo un link — sin cuenta, sin login,
 * sin exponer el resto del lote.
 *
 * No hay tabla nueva ni consulta al store para emitir o verificar un
 * token: la autorización va firmada en el propio link (HMAC-SHA256 sobre
 * `tenantId`/`jobId`/`rowId`/vencimiento), el mismo principio que ya usan
 * las claves de API —se verifican por hash, nunca por búsqueda en una
 * lista— llevado un paso más allá: acá ni siquiera hace falta guardar nada
 * para poder emitir uno.
 *
 * **La garantía que no se puede romper**: el `tenantId` que autoriza la
 * corrección sale ÚNICAMENTE del token ya verificado, nunca de la URL ni
 * de lo que declare quien llama — mismo principio que `BatchStore` ya
 * exige para toda lectura de la API (ver store.ts). Quien consuma
 * `verifyCorrectionToken` debe usar `payload.tenantId` para leer y
 * escribir la fila, no un id que venga de otro lado.
 */

export interface CorrectionLinkConfig {
  /** Secreto del despliegue para firmar y verificar. Nunca viaja en el token. */
  secret: string;
  /** Página que va a atender el link (paso siguiente). Ej.: "https://miapp.com/corregir". */
  baseUrl: string;
  /**
   * Cuánto dura el link. 7 días por defecto: alcanza para que alguien lo
   * abra desde un correo sin revisar la bandeja al toque, y no lo deja
   * dando vueltas indefinidamente sobre un domicilio de una persona.
   */
  ttlMs?: number;
}

export interface CorrectionTokenPayload {
  tenantId: string;
  jobId: string;
  rowId: string;
  /** Unix ms de vencimiento. */
  exp: number;
}

export interface CorrectionLink {
  token: string;
  url: string;
  /** ISO 8601. */
  expiresAt: string;
}

export type VerifyCorrectionTokenResult =
  | { ok: true; payload: CorrectionTokenPayload }
  | { ok: false; error: "malformed" | "invalid_signature" | "expired" };

// ---------- codificación ----------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(text: string): Uint8Array | null {
  // Nunca debe reventar con un token adulterado o incompleto — un 400
  // claro, no una excepción no capturada en medio del handler.
  try {
    const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(text.length + ((4 - (text.length % 4)) % 4), "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function signPayload(secret: string, payloadBytes: Uint8Array): Promise<string> {
  const key = await hmacKey(secret);
  // El cast es por una discrepancia de tipos de TypeScript entre
  // `Uint8Array<ArrayBufferLike>` (lo que devuelve un `Uint8Array` genérico
  // cuando pasa por una variable) y `BufferSource` (lo que pide Web
  // Crypto) — en tiempo de ejecución es exactamente el mismo dato.
  const signature = await crypto.subtle.sign("HMAC", key, payloadBytes as BufferSource);
  return base64UrlEncode(new Uint8Array(signature));
}

// ---------- emitir y verificar ----------

export async function createCorrectionLink(
  config: CorrectionLinkConfig,
  params: { tenantId: string; jobId: string; rowId: string },
): Promise<CorrectionLink> {
  const exp = Date.now() + (config.ttlMs ?? 7 * 24 * 60 * 60 * 1000);
  const payload: CorrectionTokenPayload = { ...params, exp };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = await signPayload(config.secret, payloadBytes);
  const token = `${base64UrlEncode(payloadBytes)}.${signature}`;

  const url = new URL(config.baseUrl);
  url.searchParams.set("token", token);

  return { token, url: url.toString(), expiresAt: new Date(exp).toISOString() };
}

/**
 * Verifica un token y devuelve lo que autoriza, o por qué no.
 *
 * Tres motivos de rechazo, no uno genérico, porque cada uno significa algo
 * distinto para quien integra: `malformed` es un token roto o de otro
 * sistema, `invalid_signature` es uno adulterado o firmado con otro
 * secreto, `expired` es uno legítimo que ya cumplió su plazo — el único de
 * los tres donde "pídele que abra el link de nuevo" tiene sentido.
 */
export async function verifyCorrectionToken(
  config: { secret: string },
  token: string,
): Promise<VerifyCorrectionTokenResult> {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, error: "malformed" };

  const payloadBytes = base64UrlDecode(parts[0]);
  if (!payloadBytes) return { ok: false, error: "malformed" };

  let payload: CorrectionTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return { ok: false, error: "malformed" };
  }
  if (
    typeof payload?.tenantId !== "string" ||
    typeof payload?.jobId !== "string" ||
    typeof payload?.rowId !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return { ok: false, error: "malformed" };
  }

  const expected = await signPayload(config.secret, payloadBytes);
  if (!timingSafeEqual(expected, parts[1])) return { ok: false, error: "invalid_signature" };

  if (payload.exp < Date.now()) return { ok: false, error: "expired" };

  return { ok: true, payload };
}
