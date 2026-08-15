import { describe, expect, it } from "vitest";
import { parseCoordinates } from "./coords.ts";

const santiago = { country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 };

describe("parseCoordinates", () => {
  it("par decimal con coma separadora", () => {
    const r = parseCoordinates("-33.4489, -70.6693");
    expect(r).toMatchObject({ ok: true, lat: -33.4489, lng: -70.6693 });
  });

  it("par decimal sin espacio", () => {
    const r = parseCoordinates("-33.4489,-70.6693");
    expect(r).toMatchObject({ ok: true, lat: -33.4489, lng: -70.6693 });
  });

  it("decimales con coma (formato es-CL) separados por espacio", () => {
    const r = parseCoordinates("-33,4489 -70,6693");
    expect(r).toMatchObject({ ok: true, lat: -33.4489, lng: -70.6693 });
  });

  it("decimales con coma y coma separadora", () => {
    const r = parseCoordinates("-33,4489, -70,6693");
    expect(r).toMatchObject({ ok: true, lat: -33.4489, lng: -70.6693 });
  });

  it("grados minutos segundos con hemisferios", () => {
    const r = parseCoordinates(`33°26'56.0"S 70°39'05.4"W`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lat).toBeCloseTo(-33.448889, 4);
      expect(r.lng).toBeCloseTo(-70.6515, 4);
    }
  });

  it("DMS con O de Oeste y orden invertido", () => {
    const r = parseCoordinates(`70°39'05.4"O 33°26'56.0"S`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.lat).toBeCloseTo(-33.448889, 4);
      expect(r.lng).toBeCloseTo(-70.6515, 4);
    }
  });

  it("URL de Google Maps con @", () => {
    const r = parseCoordinates("https://www.google.com/maps/@-33.4372,-70.6506,15z");
    expect(r).toMatchObject({ ok: true, lat: -33.4372, lng: -70.6506 });
  });

  it("URL de Google Maps con q=", () => {
    const r = parseCoordinates("https://maps.google.com/?q=-33.4372,-70.6506");
    expect(r).toMatchObject({ ok: true, lat: -33.4372, lng: -70.6506 });
  });

  it("corrige inversión inequívoca (|lat| > 90)", () => {
    const r = parseCoordinates("-170.5, 45.2");
    expect(r).toMatchObject({ ok: true, lat: 45.2, lng: -170.5 });
    if (r.ok) expect(r.warnings).toContain("swapped");
  });

  it("corrige inversión ambigua usando la zona esperada", () => {
    // lng, lat de Santiago en orden invertido: ambos ≤ 90
    const r = parseCoordinates("-70.6693, -33.4489", santiago);
    expect(r).toMatchObject({ ok: true, lat: -33.4489, lng: -70.6693 });
    if (r.ok) expect(r.warnings).toContain("swapped");
  });

  it("advierte punto lejos de la zona esperada", () => {
    const r = parseCoordinates("40.4168, -3.7038", santiago); // Madrid
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toContain("far_from_bias");
  });

  it("rechaza fuera de rango", () => {
    expect(parseCoordinates("95.1, 190.2")).toMatchObject({ ok: false, error: "out_of_range" });
  });

  it("rechaza texto no parseable", () => {
    expect(parseCoordinates("Av. Providencia 1234")).toMatchObject({
      ok: false,
      error: "unparseable",
    });
  });

  it("rechaza vacío", () => {
    expect(parseCoordinates("   ")).toMatchObject({ ok: false, error: "empty" });
  });
});
