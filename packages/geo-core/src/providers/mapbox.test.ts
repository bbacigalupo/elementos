import { afterEach, describe, expect, it, vi } from "vitest";
import { createMapboxProvider } from "./mapbox.ts";
import { ProviderAuthError, ProviderRateLimitError } from "../fetch-retry.ts";

/**
 * La primera fixture ("Casa Blanca") es la respuesta de ejemplo real que
 * trae la propia documentación de Mapbox (Geocoding API v6, sección
 * "Batch geocoding") — copiada, no inventada. La segunda ("Ñuñoa") se
 * construye a partir de la semántica de campos que esa misma documentación
 * describe (`locality` = comuna en Chile), porque no hay una respuesta real
 * chilena para copiar sin gastar cuota de la cuenta de prueba de Bernardo;
 * si algo acá no calza con la API real, es la fixture la que hay que
 * corregir, no asumir que el mapeo está mal.
 */
function featureCollection(features: unknown[]) {
  return new Response(JSON.stringify({ type: "FeatureCollection", features }), { status: 200 });
}

const CASA_BLANCA = {
  type: "Feature",
  id: "dXJuOm1ieGFkcjo2YzdhYjM4Yi05YzM4LTQ3ZDItODFkMS1jYzZlYjg5YzliMWM",
  geometry: { type: "Point", coordinates: [-77.03655, 38.89768] },
  properties: {
    mapbox_id: "dXJuOm1ieGFkcjo2YzdhYjM4Yi05YzM4LTQ3ZDItODFkMS1jYzZlYjg5YzliMWM",
    feature_type: "address",
    name: "1600 Pennsylvania Avenue Northwest",
    coordinates: { longitude: -77.03655, latitude: 38.89768, accuracy: "rooftop" },
    place_formatted: "Washington, District of Columbia 20500, United States",
    context: {
      address: { address_number: "1600", street_name: "Pennsylvania Avenue Northwest" },
      street: { name: "Pennsylvania Avenue Northwest" },
      neighborhood: { name: "National Mall" },
      postcode: { name: "20500" },
      place: { name: "Washington" },
      region: { name: "District of Columbia", region_code: "DC" },
      country: { name: "United States", country_code: "US" },
    },
  },
};

function nunoa(overrides: Partial<(typeof CASA_BLANCA)["properties"]["coordinates"]> = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [-70.5979, -33.4569] },
    properties: {
      mapbox_id: "mb-nunoa-1",
      feature_type: "address",
      name: "Avenida Grecia 3000",
      coordinates: { longitude: -70.5979, latitude: -33.4569, accuracy: "rooftop", ...overrides },
      place_formatted: "Ñuñoa, Región Metropolitana de Santiago, Chile",
      context: {
        address: { address_number: "3000", street_name: "Avenida Grecia" },
        street: { name: "Avenida Grecia" },
        locality: { name: "Nunoa" }, // sin tilde a propósito: prueba que canonicaliza igual
        place: { name: "Santiago" },
        region: { name: "Región Metropolitana de Santiago" },
        country: { name: "Chile", country_code: "CL" },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createMapboxProvider", () => {
  it("mapea la respuesta real de ejemplo de Mapbox (Casa Blanca) a LocationValue", async () => {
    const fetchFalso = vi.fn(async () => featureCollection([CASA_BLANCA]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    const resultado = await provider.geocode("1600 Pennsylvania Ave", { country: "US" });
    expect(resultado).not.toBeNull();
    expect(resultado!.value.lat).toBeCloseTo(38.89768);
    expect(resultado!.value.lng).toBeCloseTo(-77.03655);
    expect(resultado!.value.components).toMatchObject({
      street: "Pennsylvania Avenue Northwest",
      number: "1600",
      city: "Washington",
      region: "District of Columbia",
      postalCode: "20500",
      country: "US",
    });
    expect(resultado!.value.precision).toBe("rooftop");
    expect(resultado!.matchedLevel).toBe("address");
    expect(resultado!.value.provider).toBe("mapbox");
  });

  it("en Chile, `locality` se traduce a comuna con la grafía del catálogo (Ñuñoa)", async () => {
    const fetchFalso = vi.fn(async () => featureCollection([nunoa()]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    const resultado = await provider.geocode("Av. Grecia 3000", { country: "CL" });
    expect(resultado!.value.components.commune).toBe("Ñuñoa");
    expect(resultado!.value.components.city).toBe("Santiago");
  });

  it("accuracy `interpolated` se traduce a precision `interpolated`, no a `rooftop` ni a `zone`", async () => {
    const fetchFalso = vi.fn(async () => featureCollection([nunoa({ accuracy: "interpolated" })]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    const resultado = await provider.geocode("Av. Grecia 3050", { country: "CL" });
    expect(resultado!.value.precision).toBe("interpolated");
    // No se reusa `precisionToMatchedLevel` de osm.ts justamente porque esa
    // mandaría esto a "zone" — ver el comentario en mapbox.ts.
    expect(resultado!.matchedLevel).toBe("address");
  });

  it("reverse() usa el punto pedido como coordenada final, no el que redondea Mapbox", async () => {
    const fetchFalso = vi.fn(async () => featureCollection([nunoa()]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    const resultado = await provider.reverse(-33.457, -70.598);
    expect(resultado!.lat).toBe(-33.457);
    expect(resultado!.lng).toBe(-70.598);
    expect(resultado!.source).toBe("pin");
  });

  it("sin `permanent`, no es cacheable — modo temporal por omisión, nunca se manda `permanent=true`", async () => {
    const fetchFalso = vi.fn<typeof fetch>(async () => featureCollection([]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    expect(provider.capabilities.cacheable).toBe(false);
    await provider.geocode("Av. Grecia 3000", { country: "CL" });
    const url = new URL(fetchFalso.mock.calls[0][0] as string);
    expect(url.searchParams.has("permanent")).toBe(false);
  });

  it("con `permanent: true`, es cacheable y manda `permanent=true` — solo debe activarse con el plan pagado", async () => {
    const fetchFalso = vi.fn<typeof fetch>(async () => featureCollection([]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba", permanent: true });

    expect(provider.capabilities.cacheable).toBe(true);
    await provider.geocode("Av. Grecia 3000", { country: "CL" });
    const url = new URL(fetchFalso.mock.calls[0][0] as string);
    expect(url.searchParams.get("permanent")).toBe("true");
  });

  it("geocode() pide autocomplete=false (coincidencia completa, no por prefijo)", async () => {
    const fetchFalso = vi.fn<typeof fetch>(async () => featureCollection([]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    await provider.geocode("Av. Grecia 3000", { country: "CL" });
    const url = new URL(fetchFalso.mock.calls[0][0] as string);
    expect(url.searchParams.get("autocomplete")).toBe("false");
    expect(url.searchParams.get("country")).toBe("cl");
  });

  it("bias.center se manda como proximity=lng,lat (bias blando, no bbox)", async () => {
    const fetchFalso = vi.fn<typeof fetch>(async () => featureCollection([]));
    vi.stubGlobal("fetch", fetchFalso);
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });

    await provider.geocode("Av. Grecia 3000", { country: "CL", center: { lat: -33.45, lng: -70.6 } });
    const url = new URL(fetchFalso.mock.calls[0][0] as string);
    expect(url.searchParams.get("proximity")).toBe("-70.6,-33.45");
  });

  it("un 429 se propaga como ProviderRateLimitError, no como falla genérica", async () => {
    // retry-after grande (>3 s) para que fetchWithRetry devuelva de inmediato
    // en vez de esperar de verdad — mismo truco que fetch-retry.test.ts.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "120" } })));
    const provider = createMapboxProvider({ accessToken: "token-de-prueba" });
    await expect(provider.geocode("Av. Grecia 3000", { country: "CL" })).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
  });

  it("un 401 (token inválido) se propaga como ProviderAuthError, no como falla genérica", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const provider = createMapboxProvider({ accessToken: "token-invalido" });
    await expect(provider.geocode("Av. Grecia 3000", { country: "CL" })).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("sin accessToken, lanza de inmediato en vez de consultar con una clave vacía", () => {
    expect(() => createMapboxProvider({ accessToken: "" })).toThrow();
  });
});
