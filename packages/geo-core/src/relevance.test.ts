import { describe, expect, it } from "vitest";
import { assessSuggestions, normalizeTokens, suggestionCoverage } from "./relevance.ts";
import type { Suggestion } from "./types.ts";

function sug(label: string, sublabel: string): Suggestion {
  return {
    id: label,
    label,
    sublabel,
    value: {
      lat: 0,
      lng: 0,
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

describe("normalizeTokens", () => {
  it("quita tildes y mayúsculas, conserva números", () => {
    expect(normalizeTokens("Las Raíces 1700, Peñalolén")).toEqual([
      "las",
      "raices",
      "1700",
      "penalolen",
    ]);
  });
});

describe("assessSuggestions", () => {
  it("caso real: sugerencias que no coinciden → weak", () => {
    // Escribió "las raices 1700 peñalolen"; el geocoder ofrece la calle sin
    // número y otra calle con ese número.
    const result = assessSuggestions("las raices 1700 peñalolen", [
      sug("Las Raíces", "Santiago, Región Metropolitana de Santiago"),
      sug("Avenida Las Perdices 1700", "Santiago, Región Metropolitana de Santiago"),
    ]);
    expect(result).toBe("weak");
  });

  it("match completo con tildes distintas → strong", () => {
    const result = assessSuggestions("las raices 1700 peñalolen", [
      sug("Las Raíces 1700", "Peñalolén, Región Metropolitana de Santiago"),
    ]);
    expect(result).toBe("strong");
  });

  it("calle correcta pero sin el número escrito → weak", () => {
    const result = assessSuggestions("moneda 975", [
      sug("Moneda", "Santiago, Región Metropolitana de Santiago"),
    ]);
    expect(result).toBe("weak");
  });

  it("último token a medio escribir cuenta como match (prefijo)", () => {
    const result = assessSuggestions("plaza de armas santi", [
      sug("Plaza de Armas", "Santiago, Región Metropolitana de Santiago"),
    ]);
    expect(result).toBe("strong");
  });

  it("sin sugerencias → weak", () => {
    expect(assessSuggestions("cualquier cosa", [])).toBe("weak");
  });

  it("coverage: parcial", () => {
    const c = suggestionCoverage(
      "las raices 1700 peñalolen",
      sug("Las Raíces", "Santiago, Región Metropolitana de Santiago"),
    );
    expect(c).toBe(0.5);
  });
});
