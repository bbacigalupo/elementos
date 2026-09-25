import { describe, expect, it } from "vitest";
import type { BatchResultRow } from "@bbacigalupo/geo-core";
import { googleMapsSearchUrl, needsManualLookup, queryWithArea } from "./google-maps.ts";

function fila(raw: string, status: BatchResultRow["status"], area?: string): BatchResultRow {
  return {
    row: { id: "r1", index: 2, raw, query: raw, adminArea: area ? { name: area } : undefined },
    status,
    value: null,
    issues: [],
  } as unknown as BatchResultRow;
}

function query(url: string): string {
  return new URL(url).searchParams.get("query") ?? "";
}

describe("googleMapsSearchUrl", () => {
  it("usa el formato público Maps URLs (api=1, sin clave)", () => {
    const url = new URL(googleMapsSearchUrl(fila("Av. Grecia 3000", "uncertain")));
    expect(url.origin + url.pathname).toBe("https://www.google.com/maps/search/");
    expect(url.searchParams.get("api")).toBe("1");
    expect(url.searchParams.has("key")).toBe(false);
  });

  it("agrega la comuna declarada y el país cuando no están escritos", () => {
    expect(query(googleMapsSearchUrl(fila("Av. Grecia 3000", "uncertain", "Ñuñoa"), "CL"))).toBe(
      "Av. Grecia 3000, Ñuñoa, Chile",
    );
  });

  it("no repite el país si la persona ya lo escribió", () => {
    expect(query(googleMapsSearchUrl(fila("Av. Grecia 3000, Ñuñoa, Chile", "failed"), "CL"))).toBe(
      "Av. Grecia 3000, Ñuñoa, Chile",
    );
  });

  it("sin país conocido (selector sin elegir) deja solo el texto", () => {
    expect(query(googleMapsSearchUrl(fila("Av. Grecia 3000", "failed"), ""))).toBe("Av. Grecia 3000");
  });

  it("codifica caracteres especiales para que la URL no se rompa", () => {
    const url = googleMapsSearchUrl(fila("Pasaje N° 12 & Los Aromos #3", "failed"));
    expect(url).not.toContain(" ");
    expect(url).not.toContain("#");
    // Solo dos parámetros: el "&" de la dirección no debe partir la URL.
    expect(url.split("?")[1].split("&")).toHaveLength(2);
    expect(query(url)).toBe("Pasaje N° 12 & Los Aromos #3");
  });
});

describe("needsManualLookup", () => {
  it("solo para inciertas y fallidas", () => {
    expect(needsManualLookup(fila("x", "uncertain"))).toBe(true);
    expect(needsManualLookup(fila("x", "failed"))).toBe(true);
    expect(needsManualLookup(fila("x", "ok"))).toBe(false);
    expect(needsManualLookup(fila("x", "corrected"))).toBe(false);
    expect(needsManualLookup(fila("x", "pending"))).toBe(false);
  });
});

describe("queryWithArea (movida desde CorrectionForm, mismo comportamiento)", () => {
  it("no duplica la comuna si ya está escrita", () => {
    expect(queryWithArea(fila("Av. Grecia 3000, Nunoa", "uncertain", "Ñuñoa"))).toBe("Av. Grecia 3000, Nunoa");
  });
});
