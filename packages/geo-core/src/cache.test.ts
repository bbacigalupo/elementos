import { describe, expect, it, vi } from "vitest";
import { withCache } from "./cache.ts";
import { withCircuitBreaker, CircuitOpenError } from "./circuit-breaker.ts";
import type { GeoProvider } from "./providers/types.ts";
import type { GeoBias, LocationValue } from "./types.ts";

const bias: GeoBias = { country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 };

function valorFalso(nombre: string): LocationValue {
  return {
    lat: -33.44,
    lng: -70.66,
    formatted: nombre,
    components: {
      street: null, number: null, sublocality: null, commune: null,
      city: null, region: null, postalCode: null, country: "CL",
    },
    precision: "rooftop",
    source: "autocomplete",
    provider: "falso",
    capturedAt: new Date().toISOString(),
  };
}

function proveedorFalso(overrides: Partial<GeoProvider> = {}) {
  const llamadas = { autocomplete: 0, geocode: 0, reverse: 0 };
  const provider: GeoProvider = {
    name: "falso",
    capabilities: { autocomplete: true, geocode: true, reverse: true },
    async autocomplete() {
      llamadas.autocomplete += 1;
      return [{ id: "1", label: "Moneda 1025", sublabel: "Las Condes", value: valorFalso("Moneda 1025") }];
    },
    async geocode() {
      llamadas.geocode += 1;
      return { value: valorFalso("Moneda 1025"), matchedLevel: "address" as const };
    },
    async reverse() {
      llamadas.reverse += 1;
      return valorFalso("Moneda 1025");
    },
    ...overrides,
  };
  return { provider, llamadas };
}

describe("withCache", () => {
  it("la misma consulta no vuelve a llamar al proveedor", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider);
    await conCache.autocomplete("Moneda 1025", bias);
    await conCache.autocomplete("Moneda 1025", bias);
    await conCache.autocomplete("  MONEDA   1025 ", bias); // mismo texto, otro formato
    expect(llamadas.autocomplete).toBe(1);
  });

  it("consultas distintas sí llaman al proveedor", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider);
    await conCache.autocomplete("Moneda 1025", bias);
    await conCache.autocomplete("Moneda 975", bias);
    expect(llamadas.autocomplete).toBe(2);
  });

  it("distinta comuna declarada es distinta consulta", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider);
    await conCache.autocomplete("Moneda 1025", bias, { adminArea: { name: "Las Condes" } });
    await conCache.autocomplete("Moneda 1025", bias, { adminArea: { name: "Providencia" } });
    expect(llamadas.autocomplete).toBe(2);
  });

  it("fusiona peticiones idénticas simultáneas en una sola llamada", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider);
    // Veinte personas escribiendo lo mismo en el mismo instante.
    await Promise.all(Array.from({ length: 20 }, () => conCache.geocode("Moneda 1025", bias)));
    expect(llamadas.geocode).toBe(1);
  });

  it("el reverse reutiliza puntos cercanos pero devuelve la coordenada pedida", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider);
    const a = await conCache.reverse(-33.44891, -70.66931);
    const b = await conCache.reverse(-33.44892, -70.66932); // ~1 m
    expect(llamadas.reverse).toBe(1);
    expect(b?.lat).toBe(-33.44892);
    expect(b?.lng).toBe(-70.66932);
    expect(a?.lat).toBe(-33.44891);
  });

  it("no cachea respuestas vacías: pueden ser un fallo pasajero", async () => {
    const { provider, llamadas } = proveedorFalso({ async geocode() { llamadas.geocode += 1; return null; } });
    const conCache = withCache(provider);
    await conCache.geocode("no existe", bias);
    await conCache.geocode("no existe", bias);
    expect(llamadas.geocode).toBe(2);
  });

  it("respeta a los proveedores que no permiten almacenar resultados", async () => {
    const { provider, llamadas } = proveedorFalso();
    provider.capabilities.cacheable = false;
    const conCache = withCache(provider);
    await conCache.autocomplete("Moneda 1025", bias);
    await conCache.autocomplete("Moneda 1025", bias);
    expect(llamadas.autocomplete).toBe(2);
  });

  it("descarta las entradas más antiguas al llenarse", async () => {
    const { provider, llamadas } = proveedorFalso();
    const conCache = withCache(provider, { maxEntries: 2 });
    await conCache.geocode("a", bias);
    await conCache.geocode("b", bias);
    await conCache.geocode("c", bias); // expulsa "a"
    await conCache.geocode("a", bias);
    expect(llamadas.geocode).toBe(4);
  });
});

describe("withCircuitBreaker", () => {
  it("abre el circuito tras fallos seguidos y deja de llamar al proveedor", async () => {
    let llamadas = 0;
    const { provider } = proveedorFalso({
      async geocode() { llamadas += 1; throw new Error("proveedor caído"); },
    });
    const protegido = withCircuitBreaker(provider, { failureThreshold: 3, resetMs: 10_000 });

    for (let i = 0; i < 3; i++) {
      await expect(protegido.geocode("x", bias)).rejects.toThrow("proveedor caído");
    }
    // Con el circuito abierto ya no se toca la red.
    await expect(protegido.geocode("x", bias)).rejects.toBeInstanceOf(CircuitOpenError);
    await expect(protegido.geocode("x", bias)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(llamadas).toBe(3);
  });

  it("deja pasar una prueba cuando vence la espera y se cierra si funciona", async () => {
    let fallar = true;
    let llamadas = 0;
    const { provider } = proveedorFalso({
      async geocode() {
        llamadas += 1;
        if (fallar) throw new Error("caído");
        return { value: valorFalso("ok"), matchedLevel: "address" as const };
      },
    });
    const protegido = withCircuitBreaker(provider, { failureThreshold: 2, resetMs: 50 });

    await expect(protegido.geocode("x", bias)).rejects.toThrow();
    await expect(protegido.geocode("x", bias)).rejects.toThrow();
    await expect(protegido.geocode("x", bias)).rejects.toBeInstanceOf(CircuitOpenError);

    fallar = false;
    await new Promise((r) => setTimeout(r, 60));
    const resultado = await protegido.geocode("x", bias);
    expect(resultado?.value.formatted).toBe("ok");
    // Ya cerrado: vuelve a pasar todo.
    await protegido.geocode("y", bias);
    expect(llamadas).toBe(4);
  });

  it("cancelar no cuenta como fallo del proveedor", async () => {
    const { provider } = proveedorFalso({
      async geocode() { throw new DOMException("Aborted", "AbortError"); },
    });
    const alCambiar = vi.fn();
    const protegido = withCircuitBreaker(provider, { failureThreshold: 2, onStateChange: alCambiar });
    for (let i = 0; i < 5; i++) {
      await expect(protegido.geocode("x", bias)).rejects.toThrow(/abort/i);
    }
    expect(alCambiar).not.toHaveBeenCalled();
  });
});
