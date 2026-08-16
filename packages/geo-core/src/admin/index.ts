import { normalizeTokens } from "../relevance.ts";
import { CL_COMUNAS } from "./cl.ts";

/**
 * Catálogos de divisiones administrativas por país.
 *
 * Existen por un problema muy concreto: **OSM no dice en qué campo viene la
 * comuna**, y el campo cambia según la ciudad. Medido contra LocationIQ con
 * direcciones reales de Chile:
 *
 * | Dirección                  | comuna real | `suburb`   | `city`   |
 * |----------------------------|-------------|------------|----------|
 * | Av. Apoquindo 4501         | Las Condes  | Las Condes | Santiago |
 * | Av. Grecia 3000            | Ñuñoa       | Ñuñoa      | Santiago |
 * | Moneda 1025                | Santiago    | —          | Santiago |
 * | Av. Pedro Montt 1900 (Valpo)| Valparaíso | Almendral  | Valparaíso |
 *
 * En el Gran Santiago la comuna está en `suburb` y `city` nombra a toda la
 * conurbación; en Valparaíso es exactamente al revés. Preferir un campo
 * fijo acierta en una ciudad y falla en la otra. Preguntar **cuál de los
 * valores es una comuna de verdad** acierta en las dos.
 *
 * El costo es tener la lista: 6 KB para Chile. Barato comparado con
 * exportar "Santiago" como comuna de una dirección de Las Condes, que es un
 * dato incorrecto que se propaga a rutas, informes y decisiones.
 */

/** Por país: nombre normalizado → grafía oficial. */
const CATALOGS = new Map<string, Map<string, string>>();

/** Misma normalización que el resto: sin tildes, sin mayúsculas, sin puntuación. */
function normalizeName(name: string): string {
  return normalizeTokens(name).join(" ");
}

/**
 * Registra las divisiones administrativas de un país (comunas, municipios,
 * distritos, según cómo se llamen ahí).
 *
 * Es el camino para agregar México, Perú o Panamá sin tocar este paquete:
 * quien despliegue pasa su lista y el mapeo empieza a acertar en ese país.
 */
export function registerAdminAreas(countryCode: string, names: readonly string[]): void {
  const catalog = new Map<string, string>();
  for (const name of names) catalog.set(normalizeName(name), name);
  CATALOGS.set(countryCode.toUpperCase(), catalog);
}

/** ¿Este texto es una división administrativa conocida del país? */
export function isKnownAdminArea(countryCode: string | null | undefined, name: string | null | undefined): boolean {
  return canonicalAdminArea(countryCode, name) !== null;
}

/**
 * La grafía oficial de una división administrativa, o `null` si no está en
 * el catálogo.
 *
 * Existe porque el nombre llega escrito de cualquier forma —"NUNOA",
 * "peñalolen", "Estacion Central"— y esas variantes terminan en la columna
 * Comuna de la planilla exportada. Ahí importa: quien filtra o arma una
 * tabla dinámica en Excel obtiene tres comunas distintas donde hay una, y
 * los totales por comuna quedan mal sin que nada avise.
 *
 * El catálogo ya tenía que existir para saber **cuál** de los campos de OSM
 * es la comuna; devolver la grafía en vez de un booleano no cuesta nada más.
 */
export function canonicalAdminArea(
  countryCode: string | null | undefined,
  name: string | null | undefined,
): string | null {
  if (!countryCode || !name) return null;
  const catalog = CATALOGS.get(countryCode.toUpperCase());
  return catalog?.get(normalizeName(name)) ?? null;
}

/**
 * ¿Este texto es una división administrativa de **algún** país registrado?
 *
 * Se usa para no borrar por error un nombre que parece prescindible y no lo
 * es: "Villa Alemana" y "Villa Alegre" son comunas, no el condominio de
 * alguien. Pregunta sin país a propósito — quien limpia el texto todavía no
 * sabe dónde queda la dirección, y equivocarse hacia el lado de conservar
 * solo cuesta una consulta con una palabra de más.
 */
export function isKnownAdminAreaAnywhere(name: string | null | undefined): boolean {
  if (!name) return false;
  const key = normalizeName(name);
  if (!key) return false;
  for (const catalog of CATALOGS.values()) {
    if (catalog.has(key)) return true;
  }
  return false;
}

/** ¿Hay catálogo para este país? Sin él, el mapeo usa su regla de siempre. */
export function hasAdminCatalog(countryCode: string | null | undefined): boolean {
  return Boolean(countryCode && CATALOGS.has(countryCode.toUpperCase()));
}

registerAdminAreas("CL", CL_COMUNAS);

export { CL_COMUNAS };
