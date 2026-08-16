/**
 * Limpieza del texto que se le manda al geocoder.
 *
 * Una nómina real no trae direcciones, trae **cómo le llega la
 * correspondencia a cada persona**: el depto, la torre, el block, el "N°"
 * antes de la altura. Todo eso es indispensable para tocar el timbre y no
 * aporta absolutamente nada al punto en el mapa — el edificio está donde
 * está sin importar el piso.
 *
 * El problema es que no es solo ruido inofensivo. Medido contra LocationIQ
 * con direcciones reales, comparando la misma dirección con y sin cada
 * agregado:
 *
 * | Agregado        | Efecto                                      |
 * |-----------------|---------------------------------------------|
 * | `N° 4501`       | baja a nivel de calle, 1 a 3,5 km de error  |
 * | `block 3`       | no devuelve ningún resultado                |
 * | `depto 42`      | sin daño                                    |
 * | `of. 301`       | sin daño                                    |
 * | `#4501`         | sin daño                                    |
 *
 * Los dos primeros rompieron en 4 de 4 casos probados. Un `N°` —que quien
 * llena la planilla escribe justamente para ser más preciso— es lo que más
 * daño hace de todo lo que se midió.
 *
 * El nombre de la villa o población merece párrafo aparte, porque resultó
 * ser lo más destructivo de todo lo medido: anteponer "Villa Los
 * Presidentes" a una dirección exacta mandó 4 de 20 consultas a **más de 40
 * km** del punto real. El nombre de una villa existe en varias comunas del
 * país y el geocoder se va detrás de otra. Peor todavía, un error de 40 km
 * pasa por debajo de las dos redes que tenemos: `far_from_bias` recién
 * avisa a los 300 km y `far_from_batch` tiene piso de 100 km.
 *
 * Aun así sacarla no es automático, porque a veces es lo único que ubica la
 * dirección: en "Villa Los Aromos, Pasaje 3" el pasaje sin la villa existe
 * en decenas de comunas. De ahí las dos condiciones para sacarla — que haya
 * otra parte con una calle de nombre propio y su altura, y que el nombre no
 * sea el de una comuna de verdad ("Villa Alemana", "Villa Alegre").
 */

import { isKnownAdminAreaAnywhere } from "../admin/index.ts";
import { normalizeTokens } from "../relevance.ts";

/**
 * Marcadores de unidad dentro de un edificio, condominio o pasaje.
 *
 * Las formas largas van primero para que la alternancia no se quede con
 * "of" cuando el texto dice "oficina".
 */
const UNIT_MARKERS = [
  "departamento",
  "depto",
  "dpto",
  "oficina",
  "of",
  "bloque",
  "block",
  "blk",
  "torre",
  "piso",
  "local",
  "interior",
  "int",
  "casa",
];

/**
 * Marcador de unidad seguido de su valor.
 *
 * El valor tiene que ser **numérico o una sola letra** ("depto 902",
 * "casa B"). Sin esa restricción, "Villa Casa de Moneda" perdería la mitad
 * del nombre: exigir que lo que sigue a "casa" sea corto y con pinta de
 * identificador deja pasar cualquier palabra de verdad.
 *
 * Se usa `(?![\wáéíóúñ])` en vez de `\b` para cerrar el token: `\b` trata
 * las tildes como frontera de palabra y cortaría "Peñalolén" por la mitad.
 */
const UNIT = new RegExp(
  String.raw`[\s,;.-]*\b(?:${UNIT_MARKERS.join("|")})\b\.?\s*(?:n[°º]?\.?\s*)?(?:\d{1,5}[a-zA-Z]?|[a-zA-Z])(?![\wáéíóúñÁÉÍÓÚÑ])`,
  "gi",
);

/**
 * Prefijo de número antes de la altura: `N°`, `Nº`, `No.`, `Nro`, `Núm.`,
 * `#`. Se borra el marcador y se conserva el número.
 *
 * La `n` sola nunca alcanza: hace falta el símbolo de grado, el punto o la
 * forma larga. En Chile hay calles llamadas "Pasaje N", y "Pasaje N 12" no
 * es el número 12 de "Pasaje" — es otra calle.
 */
const NUMBER_MARKER = new RegExp(
  String.raw`(?:#|\bn(?:ro|o|um|[uú]m|[uú]mero)?\s*[°º]\.?|\bn(?:ro|o|um|[uú]m|[uú]mero)\s*\.|\b(?:nro|n[uú]m|n[uú]mero)\b\s*)\s*(?=\d)`,
  "gi",
);

/**
 * Tipos de vía. Se ignoran tanto al comparar nombres de calle como al
 * deduplicar, porque varían libremente entre lo que la gente escribe y lo
 * que guarda OSM: "Av. Providencia" y "Avenida Providencia" son la misma
 * calle.
 */
export const STREET_TYPES = new Set([
  "av", "avda", "avenida", "calle", "cll", "pasaje", "psje", "pje", "camino", "cmno",
  "ruta", "carretera", "diagonal", "callejon", "bulevar", "boulevard", "blvd", "paseo",
  "street", "st", "road", "rd", "ave",
]);

/** Tokens de un nombre de calle, sin el tipo de vía ni números. */
export function streetTokens(text: string): string[] {
  return normalizeTokens(text).filter((t) => !STREET_TYPES.has(t) && !/^\d+$/.test(t));
}

/** Cómo se nombra un loteo o conjunto habitacional. */
const SETTLEMENT_MARKERS = new Set([
  "villa", "poblacion", "pobl", "condominio", "conjunto", "residencial", "loteo",
]);

/**
 * ¿Este trozo nombra una calle de verdad con su altura?
 *
 * "Avenida Apoquindo 4335" sí: sacándole el tipo de vía y el número queda
 * "apoquindo", un nombre propio. "Pasaje 3" no: queda vacío, y un pasaje
 * numerado sin nada más es exactamente el caso donde la villa hace falta.
 */
function isStreetAddress(segment: string): boolean {
  return /\d/.test(segment) && streetTokens(segment).length > 0;
}

/** Saca los trozos que solo nombran el loteo, cuando sobran. */
function dropSettlements(text: string): { text: string; removed: string[] } {
  const parts = text.split(",");
  if (parts.length < 2 || !parts.some(isStreetAddress)) return { text, removed: [] };

  const removed: string[] = [];
  const kept = parts.filter((part) => {
    const [primero] = normalizeTokens(part);
    const esLoteo =
      SETTLEMENT_MARKERS.has(primero ?? "") &&
      !isStreetAddress(part) &&
      // Hay comunas que se llaman así: sacarlas perdería la única pista de
      // en qué punto del país estamos.
      !isKnownAdminAreaAnywhere(part);
    if (esLoteo) removed.push(part.trim());
    return !esLoteo;
  });

  return { text: kept.join(","), removed };
}

/** Comas y espacios que quedan colgando después de sacar un pedazo. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(?:,\s*)+,/g, ",")
    .replace(/^[\s,;.-]+/, "")
    .replace(/[\s,;.-]+$/, "")
    .trim();
}

export interface CleanedQuery {
  /** El texto listo para consultar. */
  query: string;
  /** Lo que se sacó, tal como estaba. Vacío si no se tocó nada. */
  removed: string[];
}

/**
 * Deja el texto en lo que sirve para ubicar el punto.
 *
 * Es conservadora por diseño: ante la duda no toca. Si limpiar dejara el
 * texto sin letras o sin nada, devuelve el original — es preferible una
 * consulta con ruido que una consulta vacía.
 */
export function cleanQuery(text: string): CleanedQuery {
  const original = text.trim();
  if (!original) return { query: original, removed: [] };

  const conNumero = original.replace(NUMBER_MARKER, "");
  const removed: string[] = [];

  /*
   * ¿Queda alguna altura fuera de los marcadores de unidad?
   *
   * Si no queda, el número del marcador **es** la altura: en "Pasaje Los
   * Aromos casa 12" el 12 es lo único que ubica la casa. Ahí no se borra,
   * se degrada — se saca la palabra y se deja el número, que además es como
   * el geocoder espera leerlo.
   */
  const hayAlturaAparte = /\d/.test(conNumero.replace(UNIT, " "));

  const sinUnidad = conNumero.replace(UNIT, (match) => {
    const valor = match.match(/(\d{1,5}[a-zA-Z]?)(?![\wáéíóúñ])\s*$/)?.[1];
    if (!hayAlturaAparte && valor) {
      removed.push(match.replace(valor, "").trim());
      return ` ${valor}`;
    }
    removed.push(match.trim().replace(/^[,;.\s-]+/, ""));
    return " ";
  });

  const sinLoteo = dropSettlements(sinUnidad);
  removed.push(...sinLoteo.removed);

  const limpio = tidy(sinLoteo.text);
  // Sin letras no hay dirección: "block 3" a secas es mejor mandarlo tal
  // cual y dejar que el proveedor diga que no encontró nada.
  if (!limpio || !/[a-zA-Záéíóúñ]/.test(limpio)) return { query: original, removed: [] };

  return { query: limpio, removed };
}
