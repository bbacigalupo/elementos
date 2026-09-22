import { describe, expect, it, vi } from "vitest";
import { createCascadingProvider } from "./cascade.ts";
import type { GeoProvider } from "./types.ts";
import type { AddressComponents, GeocodeOutcome, MatchedLevel } from "../types.ts";

const BIAS = { country: "CL" };

/** Proveedor de mentira: devuelve siempre el mismo `outcome` (o `null`) y
 * cuenta cuántas veces se llamó `geocode`, para verificar que la cascada no
 * consulta al pagado de más. */
function proveedorFalso(nombre: string, outcome: GeocodeOutcome | null): GeoProvider & { llamadas: number } {
  const estado = { llamadas: 0 };
  return {
    name: nombre,
    capabilities: { autocomplete: true, geocode: true, reverse: true },
    get llamadas() {
      return estado.llamadas;
    },
    async geocode() {
      estado.llamadas += 1;
      return outcome;
    },
    async autocomplete() {
      return [];
    },
    async reverse() {
      return null;
    },
  } as GeoProvider & { llamadas: number };
}

function outcome(formatted: string, components: Partial<AddressComponents>, matchedLevel: MatchedLevel = "address"): GeocodeOutcome {
  return {
    matchedLevel,
    value: {
      lat: -33.44, lng: -70.65,
      formatted,
      components: {
        street: null, number: null, sublocality: null, commune: null,
        city: null, region: null, postalCode: null, country: "CL",
        ...components,
      },
      precision: matchedLevel === "address" ? "rooftop" : "street",
      source: "search",
      provider: "falso",
      capturedAt: new Date().toISOString(),
    },
  };
}

const OUTCOME_EXACTO = outcome("Moneda 1025, Santiago, CL", { street: "Moneda", number: "1025", commune: "Santiago" });
const OUTCOME_SOLO_CALLE = outcome("Moneda, Santiago, CL", { street: "Moneda", commune: "Santiago" }, "street");

describe("createCascadingProvider", () => {
  it("no escala al pagado si el gratis ya resolvió bien (el caso común, el que ahorra plata)", async () => {
    const gratis = proveedorFalso("gratis", OUTCOME_EXACTO);
    const pagado = proveedorFalso("pagado", OUTCOME_EXACTO);
    const cascada = createCascadingProvider([gratis, pagado]);

    const resultado = await cascada.geocode("Moneda 1025", BIAS);

    expect(resultado).toEqual(OUTCOME_EXACTO);
    expect(gratis.llamadas).toBe(1);
    expect(pagado.llamadas).toBe(0);
  });

  it("escala al pagado cuando el gratis deja la fila incierta", async () => {
    const gratis = proveedorFalso("gratis", OUTCOME_SOLO_CALLE); // sin altura: pedimos 1025, no la devuelve
    const pagado = proveedorFalso("pagado", OUTCOME_EXACTO);
    const cascada = createCascadingProvider([gratis, pagado]);

    const resultado = await cascada.geocode("Moneda 1025", BIAS);

    expect(resultado).toEqual(OUTCOME_EXACTO);
    expect(gratis.llamadas).toBe(1);
    expect(pagado.llamadas).toBe(1);
  });

  it("escala cuando el gratis no encuentra nada", async () => {
    const gratis = proveedorFalso("gratis", null);
    const pagado = proveedorFalso("pagado", OUTCOME_EXACTO);
    const cascada = createCascadingProvider([gratis, pagado]);

    const resultado = await cascada.geocode("Moneda 1025", BIAS);

    expect(resultado).toEqual(OUTCOME_EXACTO);
    expect(pagado.llamadas).toBe(1);
  });

  it("devuelve lo del último paso aunque siga incierto — no hay a quién más preguntarle", async () => {
    const gratis = proveedorFalso("gratis", OUTCOME_SOLO_CALLE);
    const pagado = proveedorFalso("pagado", OUTCOME_SOLO_CALLE);
    const cascada = createCascadingProvider([gratis, pagado]);

    const resultado = await cascada.geocode("Moneda 1025", BIAS);

    expect(resultado).toEqual(OUTCOME_SOLO_CALLE);
    expect(gratis.llamadas).toBe(1);
    expect(pagado.llamadas).toBe(1);
  });

  it("autocomplete y reverse delegan siempre al primer proveedor, sin escalar", async () => {
    const gratis = proveedorFalso("gratis", OUTCOME_EXACTO);
    const pagado = proveedorFalso("pagado", OUTCOME_EXACTO);
    const espiaAutocomplete = vi.spyOn(gratis, "autocomplete");
    const espiaReverse = vi.spyOn(gratis, "reverse");
    const cascada = createCascadingProvider([gratis, pagado]);

    await cascada.autocomplete("Moneda", BIAS);
    await cascada.reverse(-33.44, -70.65);

    expect(espiaAutocomplete).toHaveBeenCalledTimes(1);
    expect(espiaReverse).toHaveBeenCalledTimes(1);
  });

  it("solo es cacheable si TODOS los pasos lo son", async () => {
    const gratisCacheable = proveedorFalso("gratis", OUTCOME_EXACTO);
    const pagadoNoCacheable = proveedorFalso("pagado", OUTCOME_EXACTO);
    pagadoNoCacheable.capabilities = { ...pagadoNoCacheable.capabilities, cacheable: false };

    const cascadaMixta = createCascadingProvider([gratisCacheable, pagadoNoCacheable]);
    expect(cascadaMixta.capabilities.cacheable).toBe(false);

    const cascadaLimpia = createCascadingProvider([gratisCacheable, proveedorFalso("otro", OUTCOME_EXACTO)]);
    expect(cascadaLimpia.capabilities.cacheable).toBe(true);
  });

  it("lanza si se le da una lista vacía — no tiene sentido una cascada sin proveedores", () => {
    expect(() => createCascadingProvider([])).toThrow();
  });
});
