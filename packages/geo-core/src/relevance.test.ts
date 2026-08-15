import { describe, expect, it } from "vitest";
import { adminAreaMatches, assessSuggestions, normalizeTokens, suggestionCoverage } from "./relevance.ts";
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

describe("adminAreaMatches", () => {
  const value = (components: Partial<Suggestion["value"]["components"]>, formatted = "") => ({
    formatted,
    components: {
      street: null, number: null, sublocality: null, commune: null,
      city: null, region: null, postalCode: null, country: "CL",
      ...components,
    },
  });

  it("geocoder impreciso: declara Peñalolén y OSM dice Santiago pero deja el barrio", () => {
    // Caso real de Photon para una dirección de Peñalolén.
    const v = value({ commune: "Santiago", sublocality: "Peñalolén" }, "Las Raíces, Santiago");
    expect(adminAreaMatches(v, { name: "Peñalolén" })).toBe(true);
  });

  it("punto en otra comuna: declara Providencia y el pin está en Las Condes", () => {
    const v = value({ commune: "Las Condes", city: "Santiago" }, "Alicante 937, Las Condes, Santiago");
    expect(adminAreaMatches(v, { name: "Providencia" })).toBe(false);
  });

  it("coincidencia directa", () => {
    const v = value({ commune: "Providencia" }, "Villaseca 290, Providencia");
    expect(adminAreaMatches(v, { name: "Providencia" })).toBe(true);
  });

  it("ignora tildes y mayúsculas", () => {
    const v = value({ commune: "PEÑALOLÉN" }, "");
    expect(adminAreaMatches(v, { name: "peñalolen" })).toBe(true);
  });

  it("no confunde nombres que comparten una palabra", () => {
    const v = value({ commune: "Condes de Algo" }, "");
    expect(adminAreaMatches(v, { name: "Las Condes" })).toBe(false);
  });
});
