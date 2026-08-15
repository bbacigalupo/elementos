import type { AddressComponents, Suggestion } from "./types.ts";

/**
 * Relevancia de sugerencias respecto de lo que la persona escribió.
 *
 * Sirve para que la UI detecte el caso "hay sugerencias pero ninguna es lo
 * que busco" (ej: escribió "las raíces 1700 peñalolén" y el geocoder ofrece
 * "Las Raíces" sin número o "Las Perdices 1700" en otra calle) y ofrezca
 * explícitamente la búsqueda forzada o marcar en el mapa.
 */

/** Tokeniza sin tildes ni mayúsculas; conserva números (posibles alturas). */
export function normalizeTokens(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 || /^\d+$/.test(t));
}

/**
 * Fracción de tokens del query cubiertos por la sugerencia (label + sublabel
 * + formatted). Match por prefijo, porque el último token suele estar a
 * medio escribir ("peñalol" debe calzar con "Peñalolén").
 */
export function suggestionCoverage(query: string, suggestion: Suggestion): number {
  const qTokens = normalizeTokens(query);
  if (qTokens.length === 0) return 1;
  const sTokens = normalizeTokens(
    `${suggestion.label} ${suggestion.sublabel} ${suggestion.value.formatted}`,
  );
  const matched = qTokens.filter((q) => sTokens.some((s) => s.startsWith(q)));
  return matched.length / qTokens.length;
}

export type MatchAssessment = "strong" | "weak";

/**
 * "weak" cuando conviene ofrecer alternativas junto a las sugerencias:
 * - la mejor sugerencia cubre menos del 70% de lo escrito, o
 * - la persona escribió un número (probable altura de calle) que la mejor
 *   sugerencia no contiene — señal típica de "encontré la calle o un
 *   homónimo, pero no esa dirección".
 */
export function assessSuggestions(query: string, suggestions: Suggestion[]): MatchAssessment {
  if (suggestions.length === 0) return "weak";

  let best: Suggestion = suggestions[0];
  let bestCoverage = -1;
  for (const s of suggestions) {
    const c = suggestionCoverage(query, s);
    if (c > bestCoverage) {
      bestCoverage = c;
      best = s;
    }
  }
  if (bestCoverage < 0.7) return "weak";

  const qNumbers = normalizeTokens(query).filter((t) => /^\d+$/.test(t));
  if (qNumbers.length > 0) {
    const bestTokens = normalizeTokens(`${best.label} ${best.sublabel} ${best.value.formatted}`);
    const missingNumber = qNumbers.some((n) => !bestTokens.includes(n));
    if (missingNumber) return "weak";
  }

  return "strong";
}

/**
 * ¿El punto encontrado es consistente con la división administrativa que
 * declaró la persona?
 *
 * Hay que distinguir dos situaciones que se ven parecidas:
 *
 * - El geocoder es **impreciso**: para una dirección de Peñalolén, OSM
 *   devuelve `commune: "Santiago"` y deja "Peñalolén" en el barrio. Acá lo
 *   declarado es mejor dato y debe prevalecer.
 * - El punto está **en otra comuna**: se declaró Providencia y el pin cayó
 *   en Las Condes. Acá pisar el nombre produciría una dirección que no
 *   existe ("Alicante 937, Providencia"), y hay que avisar en vez de
 *   corregir en silencio.
 *
 * El criterio: si el nombre declarado aparece en cualquier parte de lo que
 * devolvió el geocoder, es el primer caso. Si no aparece en ninguna, es el
 * segundo.
 */
export function adminAreaMatches(
  value: { components: AddressComponents; formatted: string },
  area: { name: string },
): boolean {
  const declared = normalizeTokens(area.name);
  if (declared.length === 0) return true;
  const c = value.components;
  const haystack = normalizeTokens(
    [c.commune, c.city, c.sublocality, c.region, value.formatted].filter(Boolean).join(" "),
  );
  // Todos los tokens del nombre declarado deben aparecer: "Las Condes"
  // no calza con "Condes de Foo".
  return declared.every((token) => haystack.some((h) => h.startsWith(token)));
}
