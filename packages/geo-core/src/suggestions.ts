import type { Suggestion } from "./types.ts";

/**
 * Los geocoders OSM devuelven con frecuencia entradas repetidas para el
 * mismo lugar (el nodo y la vía de una misma plaza, o varios registros con
 * idéntico nombre y comuna). Mostrarlas todas llena la lista de opciones
 * indistinguibles y, si comparten `placeId`, además colisionan como key de
 * React.
 *
 * Deduplica por **texto visible**, no por coordenada: dos filas que se leen
 * igual son imposibles de elegir para quien responde, aunque apunten a
 * puntos distintos. Se conserva la primera (los proveedores devuelven por
 * relevancia) y la pantalla de confirmación con pin permite corregir si el
 * punto no era el esperado. Los homónimos que sí se distinguen —distinta
 * comuna o calle en el sublabel— se conservan todos.
 *
 * Además garantiza ids únicos: OSM repite `placeId` entre registros, y
 * claves duplicadas hacen que React omita o duplique filas.
 */
export function dedupeSuggestions(suggestions: Suggestion[]): Suggestion[] {
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const out: Suggestion[] = [];

  for (const s of suggestions) {
    const signature = [s.label.trim().toLowerCase(), s.sublabel.trim().toLowerCase()].join("|");
    if (seen.has(signature)) continue;
    seen.add(signature);

    let id = s.id;
    for (let i = 2; usedIds.has(id); i += 1) id = `${s.id}#${i}`;
    usedIds.add(id);

    out.push(id === s.id ? s : { ...s, id });
  }

  return out;
}
