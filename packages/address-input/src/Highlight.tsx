import { useMemo } from "react";
import { normalizeTokens } from "@allride/geo-core";

/**
 * Resalta en la sugerencia las palabras que calzan con lo escrito.
 *
 * El objetivo no es adornar: al pintar lo que sí coincide, lo que queda sin
 * pintar delata la diferencia — "Las **Perdices**" vs "Las **Raíces**" se
 * distinguen de un vistazo aunque compartan el "Las".
 *
 * Usa la misma normalización y el mismo match por prefijo que el criterio
 * de relevancia (`assessSuggestions`), así lo que se ve resaltado es
 * exactamente lo que el sistema cuenta como coincidencia.
 */

function stripAccents(word: string): string {
  return word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const queryTokens = useMemo(() => normalizeTokens(query), [query]);

  const parts = useMemo(() => {
    if (queryTokens.length === 0 || !text) return null;
    const out: Array<{ text: string; match: boolean }> = [];
    let cursor = 0;
    // \p{L}\p{N} para no cortar palabras con tildes o ñ.
    for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
      const start = m.index ?? 0;
      if (start > cursor) out.push({ text: text.slice(cursor, start), match: false });
      const word = m[0];
      const normalized = stripAccents(word);
      out.push({ text: word, match: queryTokens.some((t) => normalized.startsWith(t)) });
      cursor = start + word.length;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
    return out;
  }, [text, queryTokens]);

  if (!parts) return <>{text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.match ? (
          <mark key={i} className="ari-match">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}
