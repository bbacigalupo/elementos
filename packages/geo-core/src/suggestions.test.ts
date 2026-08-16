import { describe, expect, it } from "vitest";
import { dedupeSuggestions } from "./suggestions.ts";
import type { Suggestion } from "./types.ts";

function sug(id: string, label: string, sublabel: string, lat = -33.44, lng = -70.65): Suggestion {
  return {
    id,
    label,
    sublabel,
    value: {
      lat,
      lng,
      formatted: `${label}, ${sublabel}`,
      components: {
        street: null,
        number: null,
        sublocality: null,
        commune: null,
        city: null,
        region: null,
        postalCode: null,
        country: "CL",
      },
      precision: "street",
      source: "autocomplete",
      provider: "photon",
      capturedAt: new Date().toISOString(),
    },
  };
}

describe("dedupeSuggestions", () => {
  it("elimina entradas visualmente idénticas en el mismo punto", () => {
    const out = dedupeSuggestions([
      sug("N:1", "Estación Central", "Santiago, Región Metropolitana de Santiago"),
      sug("W:2", "Estación Central", "Santiago, Región Metropolitana de Santiago"),
    ]);
    expect(out).toHaveLength(1);
  });

  it("colapsa filas que se leen igual aunque estén en puntos distintos", () => {
    // Caso real de Photon: dos "Estación Central / Santiago, RM" separados
    // por varias cuadras. Indistinguibles para quien elige.
    const out = dedupeSuggestions([
      sug("N:1", "Estación Central", "Santiago, RM", -33.44, -70.68),
      sug("N:2", "Estación Central", "Santiago, RM", -33.5, -70.7),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("N:1"); // se conserva la de mayor relevancia
  });

  it("conserva homónimos distinguibles por el sublabel", () => {
    const out = dedupeSuggestions([
      sug("N:1", "Estación Central", "Santiago, RM"),
      sug("N:2", "Estación Central", "Avenida Libertador Bernardo O'Higgins, Santiago, RM"),
    ]);
    expect(out).toHaveLength(2);
  });

  it("garantiza ids únicos aunque el proveedor repita placeId", () => {
    const out = dedupeSuggestions([
      sug("N:1", "Av. Grecia", "Peñalolén, RM", -33.48, -70.54),
      sug("N:1", "Av. Grecia", "La Reina, RM", -33.45, -70.55),
    ]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((s) => s.id)).size).toBe(2);
  });
});
