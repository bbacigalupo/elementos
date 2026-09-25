import { normalizeTokens, type BatchResultRow } from "@bbacigalupo/geo-core";
import { countryName } from "./countries.ts";

/**
 * Enlace para abrir en Google Maps la dirección de una fila, en otra pestaña.
 *
 * Es ayuda para la revisión manual, no geocodificación: no se consulta
 * ninguna API de Google ni se lee nada de vuelta. La persona usa Google Maps
 * como referencia para **ubicar** el lugar y después marca el punto en
 * nuestro mapa. Así lo que queda guardado lo produce nuestro mapa, no una
 * coordenada copiada de Google (sus términos para uso manual restringen
 * "copy the content"; ver la memoria del proyecto, 24 sept 2026).
 *
 * Usa el formato público "Maps URLs" (`/maps/search/?api=1&query=`), que
 * según la documentación de Google no necesita clave.
 *
 * Vive en un módulo propio y liviano, no en `CorrectionForm.tsx`: la tabla
 * lo usa en el bloque principal, y `CorrectionForm` arrastra el elemento de
 * captura individual (con Leaflet), que se carga diferido a propósito.
 */

/**
 * Texto de partida para corregir.
 *
 * En una planilla por columnas la comuna viaja aparte y `raw` queda como
 * "Av. Grecia 3000", sin ella. Acá sí conviene pegarla al texto: la persona
 * está escribiendo en un buscador con autocompletado, donde la comuna es lo
 * que desambigua entre calles homónimas, al revés que en el lote, donde
 * iba como dato estructurado.
 */
export function queryWithArea(result: BatchResultRow): string {
  const area = result.row.adminArea?.name;
  if (!area) return result.row.raw;
  const escrito = normalizeTokens(result.row.raw);
  const faltante = normalizeTokens(area).some((t) => !escrito.some((e) => e.startsWith(t)));
  return faltante ? `${result.row.raw}, ${area}` : result.row.raw;
}

/** Solo las filas que alguien tiene que resolver a mano. */
export function needsManualLookup(result: BatchResultRow): boolean {
  return result.status === "uncertain" || result.status === "failed";
}

/**
 * Se agrega el país cuando no está escrito: Google no sabe que el lote es de
 * Chile, y "Los Aromos 1234" existe en muchos países.
 */
export function googleMapsSearchUrl(result: BatchResultRow, countryCode?: string): string {
  let query = queryWithArea(result);
  const pais = countryCode ? countryName(countryCode) : "";
  if (pais) {
    const escrito = normalizeTokens(query);
    const falta = normalizeTokens(pais).some((t) => !escrito.some((e) => e.startsWith(t)));
    if (falta) query = `${query}, ${pais}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
