/**
 * Claves de API: generación, hash y comparación.
 *
 * Todo con Web Crypto (`crypto.subtle`), que está en Node 18+, en los
 * runtimes de edge y en el navegador. Sin dependencias, igual que el resto
 * del monorepo.
 */

/** Prefijo visible para reconocer de un vistazo qué es y de qué entorno. */
export type KeyEnvironment = "live" | "test";

const PREFIX = "ark";

/**
 * Genera una clave nueva. **Se muestra una sola vez**: lo que se guarda es
 * su hash, así que si se pierde no hay forma de recuperarla — hay que
 * emitir otra.
 *
 * El prefijo legible (`ark_live_…`) no es decoración: permite reconocer una
 * clave filtrada en un repositorio o en un log y saber de inmediato qué
 * revocar, que es la diferencia entre un incidente de una hora y uno de una
 * semana.
 */
export function generateApiKey(environment: KeyEnvironment = "live"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${PREFIX}_${environment}_${secret}`;
}

/** SHA-256 en hexadecimal. Es lo único que se guarda de una clave. */
export async function hashApiKey(key: string): Promise<string> {
  const data = new TextEncoder().encode(key.trim());
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * ¿Tiene forma de clave nuestra?
 *
 * Sirve para rechazar basura antes de gastar un hash y una consulta a la
 * base — y de paso evita que un token de otro sistema pegado por error
 * termine buscándose acá.
 */
export function looksLikeApiKey(value: string): boolean {
  return /^ark_(live|test)_[0-9a-f]{64}$/.test(value.trim());
}

/**
 * Comparación en tiempo constante.
 *
 * Comparar hashes con `===` filtra información por el tiempo que tarda en
 * encontrar la primera diferencia. Acá el riesgo es acotado —se comparan
 * hashes, no secretos— pero es de las cosas que no cuesta nada hacer bien y
 * sí cuesta explicar por qué no se hizo.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Identificador con prefijo, para trabajos y demás entidades. */
export function generateId(prefix: string): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}_${hex}`;
}
