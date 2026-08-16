import { describe, expect, it } from "vitest";
import {
  applyOutliers,
  classifyResult,
  correctionMode,
  detectOutliers,
  summarize,
  type BatchResultRow,
  type IssueCode,
} from "./classify.ts";
import { buildRows, type BatchInputRow } from "./parse.ts";
import type { AddressComponents, GeocodeOutcome, MatchedLevel, Precision } from "../types.ts";

function row(raw: string, extra: Partial<BatchInputRow> = {}): BatchInputRow {
  return { id: "r1", index: 1, raw, query: raw, ...extra };
}

function outcome(
  formatted: string,
  components: Partial<AddressComponents>,
  matchedLevel: MatchedLevel = "address",
  coords: { lat: number; lng: number } = { lat: -33.44, lng: -70.65 },
): GeocodeOutcome {
  const precision: Precision = matchedLevel === "address" ? "rooftop" : matchedLevel === "street" ? "street" : "zone";
  return {
    matchedLevel,
    value: {
      ...coords,
      formatted,
      components: {
        street: null, number: null, sublocality: null, commune: null,
        city: null, region: null, postalCode: null, country: "CL",
        ...components,
      },
      precision,
      source: "search",
      provider: "locationiq",
      capturedAt: new Date().toISOString(),
    },
  };
}

describe("classifyResult", () => {
  it("una dirección exacta con su altura es exitosa", () => {
    const result = classifyResult(
      row("Av. Providencia 1234, Providencia"),
      outcome("Avenida Providencia 1234, Providencia, Región Metropolitana de Santiago, Chile", {
        street: "Avenida Providencia",
        number: "1234",
        commune: "Providencia",
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.issues).toEqual([]);
  });

  it("calle sin altura queda incierta, no exitosa", () => {
    // El caso real que la herramienta actual reporta como OK.
    const result = classifyResult(
      row("Av. Grecia 3000, Ñuñoa"),
      outcome("Av. Grecia, Ñuñoa, Región Metropolitana de Santiago, Chile", {
        street: "Av. Grecia",
        commune: "Peñalolén",
      }, "street"),
    );
    expect(result.status).toBe("uncertain");
    expect(result.issues.map((i) => i.code)).toContain("no_house_number");
  });

  it("no reclama altura si no se pidió ninguna", () => {
    const result = classifyResult(
      row("Plaza de Armas, Santiago"),
      outcome("Plaza de Armas, Santiago, Chile", { street: "Plaza de Armas", commune: "Santiago" }, "street"),
    );
    expect(result.status).toBe("ok");
  });

  it("detecta otra calle con el mismo número, que la cobertura general deja pasar", () => {
    const result = classifyResult(
      row("Av. Grecia 3000, Ñuñoa"),
      outcome("Av. Bilbao 3000, Ñuñoa, Región Metropolitana de Santiago, Chile", {
        street: "Av. Bilbao",
        number: "3000",
        commune: "Ñuñoa",
      }),
    );
    expect(result.status).toBe("uncertain");
    expect(result.issues.map((i) => i.code)).toContain("street_mismatch");
  });

  it("no confunde el tipo de vía con otra calle", () => {
    const result = classifyResult(
      row("Av. Providencia 1234"),
      outcome("Avenida Providencia 1234, Providencia", { street: "Avenida Providencia", number: "1234" }),
    );
    expect(result.issues.map((i) => i.code)).not.toContain("street_mismatch");
  });

  it("avisa cuando la altura encontrada no es la pedida", () => {
    const result = classifyResult(
      row("Av. Grecia 3000, Ñuñoa"),
      outcome("Av. Grecia 3050, Peñalolén", { street: "Av. Grecia", number: "1780", commune: "Peñalolén" }),
    );
    expect(result.issues.map((i) => i.code)).toContain("number_mismatch");
    expect(result.issues.find((i) => i.code === "number_mismatch")?.detail).toContain("1780");
  });

  it("el centro de una zona nunca es un resultado exitoso", () => {
    const result = classifyResult(
      row("Calle inventada 500, Maipú"),
      outcome("Maipú, Región Metropolitana de Santiago, Chile", { commune: "Maipú" }, "zone"),
    );
    expect(result.status).toBe("uncertain");
    expect(result.issues.map((i) => i.code)).toContain("zone_only");
  });

  it("avisa cuando el punto cae fuera de la comuna declarada", () => {
    const result = classifyResult(
      row("Moneda 1025", { adminArea: { name: "Providencia" } }),
      outcome("Moneda 1025, Las Condes, Región Metropolitana de Santiago", {
        street: "Moneda",
        number: "937",
        commune: "Las Condes",
      }),
    );
    expect(result.issues.map((i) => i.code)).toContain("outside_admin_area");
  });

  it("no avisa cuando la comuna declarada aparece en el resultado", () => {
    const result = classifyResult(
      row("Av. Grecia 3000", { adminArea: { name: "Ñuñoa" } }),
      outcome("Av. Grecia 3000, Ñuñoa, Región Metropolitana de Santiago", {
        street: "Av. Grecia",
        number: "3000",
        commune: "Ñuñoa",
      }),
    );
    expect(result.status).toBe("ok");
  });

  it("sin resultado del proveedor es fallido", () => {
    const result = classifyResult(row("Calle que no existe 99999, Nowhere"), null);
    expect(result.status).toBe("failed");
    expect(result.issues[0].code).toBe("no_result");
  });

  it("avisa cuando el punto queda lejísimos de la zona de operación", () => {
    const result = classifyResult(
      row("Santiago 100"),
      outcome("Santiago de Cuba, Cuba", { street: "Santiago", number: "100", city: "Santiago de Cuba" }, "address", {
        lat: 20.02,
        lng: -75.82,
      }),
      { bias: { country: "CL", center: { lat: -33.44, lng: -70.65 }, radiusKm: 40 } },
    );
    expect(result.issues.map((i) => i.code)).toContain("far_from_bias");
  });
  it("la comuna escrita cuenta aunque el proveedor la deje fuera de formatted", () => {
    /*
     * Caso real reportado: el proveedor devuelve la comuna en `sublocality`
     * y no en `formatted`. Comparando solo contra formatted,
     * la cobertura caía a 0,50 y una dirección exacta salía incierta.
     */
    const result = classifyResult(
      row("moneda 1025, santiago centro"),
      outcome("Moneda 1025, Santiago, Región Metropolitana de Santiago, CL", {
        street: "Moneda",
        number: "1025",
        sublocality: "Santiago Centro",
        commune: "Santiago",
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.issues).toEqual([]);
  });

  it("escribir la comuna nunca puede empeorar el resultado", () => {
    const sinComuna = classifyResult(
      row("presidente errázuriz 3949"),
      outcome("Avenida Presidente Errázuriz 3949, Santiago, Región Metropolitana de Santiago, CL", {
        street: "Avenida Presidente Errázuriz",
        number: "3949",
        sublocality: "Las Condes",
        commune: "Santiago",
      }),
    );
    const conComuna = classifyResult(
      row("presidente errázuriz 3949 las condes"),
      outcome("Avenida Presidente Errázuriz 3949, Santiago, Región Metropolitana de Santiago, CL", {
        street: "Avenida Presidente Errázuriz",
        number: "3949",
        sublocality: "Las Condes",
        commune: "Santiago",
      }),
    );
    expect(sinComuna.status).toBe("ok");
    expect(conComuna.status).toBe("ok");
  });

  it("sigue detectando lo que de verdad no calza", () => {
    const result = classifyResult(
      row("moneda 1025, santiago centro"),
      outcome("Plaza de Maipú, Maipú, Región Metropolitana de Santiago, CL", {
        street: "Plaza de Maipú",
        commune: "Maipú",
      }, "zone"),
    );
    expect(result.status).toBe("uncertain");
    expect(result.issues.map((i) => i.code)).toContain("weak_match");
  });
});

describe("detectOutliers", () => {
  const santiago = Array.from({ length: 8 }, (_, i) => ({
    id: `r${i + 1}`,
    lat: -33.44 + i * 0.01,
    lng: -70.65 + i * 0.01,
  }));

  it("marca el punto que aterrizó en otro país", () => {
    const cuba = { id: "rX", lat: 20.02, lng: -75.82 };
    const flagged = detectOutliers([...santiago, cuba]);
    expect([...flagged.keys()]).toEqual(["rX"]);
  });

  it("no marca a alguien que simplemente vive lejos dentro de la ciudad", () => {
    const lejos = { id: "rLejos", lat: -33.7, lng: -70.9 };
    expect(detectOutliers([...santiago, lejos]).size).toBe(0);
  });

  it("no opina con muy pocos puntos: no hay resto del lote contra el cual comparar", () => {
    expect(detectOutliers([santiago[0], santiago[1], { id: "rX", lat: 20.02, lng: -75.82 }]).size).toBe(0);
  });
});

describe("applyOutliers", () => {
  it("un resultado exitoso pasa a incierto si está lejos de todo el resto", () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: Array.from({ length: 8 }, (_, i) => `Calle ${i} 100, Santiago`).concat("Santiago 100"),
    });
    // Cada resultado es impecable visto de a uno: la calle pedida, la
    // altura pedida, precisión de dirección. El último está en Cuba.
    const results: BatchResultRow[] = rows.map((r, i) => {
      const isCuba = i === rows.length - 1;
      const street = isCuba ? "Santiago" : `Calle ${i}`;
      return classifyResult(
        r,
        outcome(`${street} 100, Santiago`, { street, number: "100" }, "address",
          isCuba ? { lat: 20.02, lng: -75.82 } : { lat: -33.44 + i * 0.01, lng: -70.65 + i * 0.01 }),
      );
    });
    expect(results.every((r) => r.status === "ok")).toBe(true);

    const after = applyOutliers(results);
    expect(after[after.length - 1].status).toBe("uncertain");
    expect(after[after.length - 1].issues.map((i) => i.code)).toContain("far_from_batch");
    expect(after.slice(0, -1).every((r) => r.status === "ok")).toBe(true);
  });
});

describe("summarize", () => {
  it("cuenta cada estado", () => {
    const results = [
      classifyResult(row("Av. Providencia 1234"), outcome("Avenida Providencia 1234", { street: "Avenida Providencia", number: "1234" })),
      classifyResult(row("Av. Grecia 3000"), outcome("Av. Grecia", { street: "Av. Grecia" }, "street")),
      classifyResult(row("Nada 1"), null),
    ];
    expect(summarize(results)).toEqual({ total: 3, ok: 1, uncertain: 1, failed: 1, corrected: 0, pending: 0 });
  });
});

describe("correctionMode", () => {
  const conMotivos = (codes: IssueCode[], conPunto = true): BatchResultRow => ({
    row: row("Av. Grecia 3000"),
    status: "uncertain",
    value: conPunto ? outcome("Av. Grecia", { street: "Av. Grecia" }).value : null,
    matchedLevel: "street",
    issues: codes.map((code) => ({ code })),
  });

  it("abre en el mapa cuando el punto solo necesita ajuste", () => {
    expect(correctionMode(conMotivos(["no_house_number"]))).toBe("map");
    expect(correctionMode(conMotivos(["number_mismatch"]))).toBe("map");
    expect(correctionMode(conMotivos(["zone_only"]))).toBe("map");
  });

  it("abre en el mapa cuando el punto está donde no corresponde: se ve al instante", () => {
    expect(correctionMode(conMotivos(["outside_admin_area"]))).toBe("map");
    expect(correctionMode(conMotivos(["far_from_batch"]))).toBe("map");
  });

  it("abre en el buscador cuando probablemente encontró otro lugar", () => {
    // Con el pin plantado en el lugar equivocado, confirmar es un solo clic.
    expect(correctionMode(conMotivos(["street_mismatch"]))).toBe("search");
    expect(correctionMode(conMotivos(["weak_match"]))).toBe("search");
  });

  it("abre en el buscador cuando no hay nada que mostrar", () => {
    expect(correctionMode(conMotivos(["no_result"], false))).toBe("search");
  });

  it("un motivo grave manda al buscador aunque venga con otros leves", () => {
    expect(correctionMode(conMotivos(["no_house_number", "street_mismatch"]))).toBe("search");
  });
});

describe("comuna declarada en la planilla", () => {
  const declarada = { adminArea: { name: "Peñalolén" } };

  it("completa la comuna cuando el proveedor no devolvió ninguna", () => {
    const result = classifyResult(
      row("Av. Grecia 3000", declarada),
      outcome("Av. Grecia 3000, Peñalolén", { street: "Av. Grecia", number: "3000", city: "Santiago" }),
    );
    expect(result.value?.components.commune).toBe("Peñalolén");
    expect(result.status).toBe("ok");
  });

  it("normaliza la grafía de lo declarado", () => {
    const result = classifyResult(
      row("Av. Grecia 3000", { adminArea: { name: "penalolen" } }),
      outcome("Av. Grecia 3000, Peñalolén", { street: "Av. Grecia", number: "3000", city: "Santiago" }),
      { bias: { country: "CL" } },
    );
    expect(result.value?.components.commune).toBe("Peñalolén");
  });

  it("no pisa la comuna que sí devolvió el proveedor", () => {
    const result = classifyResult(
      row("Av. Grecia 3000", declarada),
      outcome("Av. Grecia 3000, Peñalolén", {
        street: "Av. Grecia", number: "3000", commune: "Peñalolén", sublocality: "Lo Hermida",
      }),
    );
    expect(result.value?.components.commune).toBe("Peñalolén");
  });

  it("no completa cuando lo declarado y lo encontrado se contradicen", () => {
    const result = classifyResult(
      row("Av. Grecia 3000", declarada),
      outcome("Av. Grecia 3000, Ñuñoa", { street: "Av. Grecia", number: "3000", city: "Ñuñoa" }),
    );
    expect(result.issues.map((i) => i.code)).toContain("outside_admin_area");
    // La contradicción es el dato: taparla con lo declarado la haría desaparecer.
    expect(result.value?.components.commune).toBeNull();
  });

  it("sin división administrativa en el resultado no se afirma un desacuerdo", () => {
    // El proveedor no devolvió comuna, ni ciudad, ni región: no hay con qué
    // contradecir lo declarado, así que tampoco hay motivo para marcarla.
    const result = classifyResult(
      row("Camino El Alba 11000", declarada),
      outcome("Camino El Alba 11000", { street: "Camino El Alba", number: "11000" }),
    );
    expect(result.issues.map((i) => i.code)).not.toContain("outside_admin_area");
    expect(result.value?.components.commune).toBe("Peñalolén");
    expect(result.status).toBe("ok");
  });
});
