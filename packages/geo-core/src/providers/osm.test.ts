import { describe, expect, it } from "vitest";
import { mapOsmComponents, type OsmAddress } from "./osm.ts";
import { formatAddress } from "../types.ts";
import { isKnownAdminArea, registerAdminAreas } from "../admin/index.ts";

/**
 * Respuestas **reales** de LocationIQ, copiadas de consultas hechas contra
 * la API. Inventarlas sería inútil: el error que estos tests fijan existía
 * justamente porque los datos de prueba anteriores ponían la comuna donde
 * uno esperaría, y no donde OSM la pone.
 */
const REALES: Record<string, { address: OsmAddress; comuna: string }> = {
  "Av. Apoquindo 4501": {
    comuna: "Las Condes",
    address: {
      house_number: "4501",
      road: "Avenida Apoquindo",
      neighbourhood: "Barrio San Pascual",
      suburb: "Las Condes",
      city: "Santiago",
      county: "Provincia de Santiago",
      state: "Región Metropolitana de Santiago",
      country_code: "cl",
    },
  },
  "Av. Grecia 3000": {
    comuna: "Ñuñoa",
    address: {
      house_number: "3000",
      road: "Avenida Grecia",
      neighbourhood: "Barrio José Pedro Alessandri",
      suburb: "Ñuñoa",
      city: "Santiago",
      state: "Región Metropolitana de Santiago",
      country_code: "cl",
    },
  },
  "Av. Pajaritos 1900": {
    comuna: "Maipú",
    address: {
      house_number: "1900",
      road: "Avenida Los Pajaritos",
      neighbourhood: "Villa Casa de Moneda",
      quarter: "Maipú Centro",
      suburb: "Maipú",
      city: "Santiago",
      state: "Región Metropolitana de Santiago",
      country_code: "cl",
    },
  },
  "Moneda 1025": {
    comuna: "Santiago",
    address: {
      house_number: "1025",
      road: "Moneda",
      neighbourhood: "Santiago",
      city: "Santiago",
      state: "Región Metropolitana de Santiago",
      country_code: "cl",
    },
  },
  "Av. Pedro Montt 1900": {
    comuna: "Valparaíso",
    address: {
      house_number: "1900",
      road: "Avenida Pedro Montt",
      neighbourhood: "Cerro Lecheros",
      quarter: "Cerro Barón",
      suburb: "Almendral",
      city: "Valparaíso",
      state: "Región de Valparaíso",
      country_code: "cl",
    },
  },
  "Av. Vitacura 5250": {
    comuna: "Vitacura",
    address: {
      house_number: "5250",
      road: "Avenida Vitacura",
      suburb: "Vitacura",
      city: "Vitacura",
      state: "Región Metropolitana de Santiago",
      country_code: "cl",
    },
  },
};

describe("comuna en Chile", () => {
  for (const [direccion, caso] of Object.entries(REALES)) {
    it(`${direccion} → ${caso.comuna}`, () => {
      expect(mapOsmComponents(caso.address).commune).toBe(caso.comuna);
    });
  }

  it("en el Gran Santiago la comuna sale de suburb, no de city", () => {
    const c = mapOsmComponents(REALES["Av. Apoquindo 4501"].address);
    expect(c.commune).toBe("Las Condes");
    // La ciudad se conserva como lo que OSM dice: otro nivel, no un error.
    expect(c.city).toBe("Santiago");
  });

  it("en Valparaíso la comuna sale de city, porque suburb es un barrio", () => {
    const c = mapOsmComponents(REALES["Av. Pedro Montt 1900"].address);
    expect(c.commune).toBe("Valparaíso");
    expect(c.sublocality).toBe("Cerro Lecheros");
  });

  it("el barrio no repite a la comuna", () => {
    // Sin `neighbourhood`, `suburb` es la comuna y no debe aparecer dos veces.
    const c = mapOsmComponents(REALES["Av. Vitacura 5250"].address);
    expect(c.commune).toBe("Vitacura");
    expect(c.sublocality).toBeNull();
  });

  it("ignora los valores que no son comunas de verdad", () => {
    // "Maipú Centro" es un barrio con nombre parecido: no debe ganarle a "Maipú".
    const c = mapOsmComponents(REALES["Av. Pajaritos 1900"].address);
    expect(c.commune).toBe("Maipú");
  });

  it("corrige también la dirección formateada, no solo la columna", () => {
    const c = mapOsmComponents(REALES["Av. Apoquindo 4501"].address);
    // Antes decía "…, Santiago, …" para una dirección de Las Condes.
    expect(formatAddress(c)).toBe(
      "Avenida Apoquindo 4501, Las Condes, Región Metropolitana de Santiago, CL",
    );
  });
});

describe("países sin catálogo", () => {
  it("mantiene la regla de siempre: city, luego town", () => {
    const c = mapOsmComponents({
      road: "Rua Augusta",
      house_number: "100",
      suburb: "Consolação",
      city: "São Paulo",
      state: "São Paulo",
      country_code: "br",
    });
    expect(c.commune).toBe("São Paulo");
    expect(c.sublocality).toBe("Consolação");
  });

  it("un catálogo nuevo empieza a acertar sin tocar el paquete", () => {
    expect(isKnownAdminArea("MX", "Cuauhtémoc")).toBe(false);
    registerAdminAreas("MX", ["Cuauhtémoc", "Benito Juárez", "Miguel Hidalgo"]);
    expect(isKnownAdminArea("MX", "cuauhtemoc")).toBe(true);

    const c = mapOsmComponents({
      road: "Avenida Paseo de la Reforma",
      house_number: "222",
      suburb: "Cuauhtémoc",
      city: "Ciudad de México",
      country_code: "mx",
    });
    expect(c.commune).toBe("Cuauhtémoc");
  });
});

describe("catálogo de comunas", () => {
  it("reconoce nombres con tildes y sin ellas, en cualquier caja", () => {
    expect(isKnownAdminArea("CL", "Ñuñoa")).toBe(true);
    expect(isKnownAdminArea("CL", "nunoa")).toBe(true);
    expect(isKnownAdminArea("CL", "  LAS CONDES  ")).toBe(true);
    expect(isKnownAdminArea("CL", "Peñalolén")).toBe(true);
  });

  it("no confunde barrios con comunas", () => {
    expect(isKnownAdminArea("CL", "Almendral")).toBe(false);
    expect(isKnownAdminArea("CL", "Maipú Centro")).toBe(false);
    expect(isKnownAdminArea("CL", "Barrio San Pascual")).toBe(false);
  });
});

describe("grafía oficial de la comuna", () => {
  /*
   * Los datos de OSM los edita cualquiera y la misma comuna convive escrita
   * de varias formas. En la planilla exportada eso se nota: filtrar por
   * comuna deja fuera filas, y una tabla dinámica cuenta dos comunas donde
   * hay una.
   */
  it("devuelve el nombre del catálogo y no el que trae OSM", () => {
    const c = mapOsmComponents({
      road: "Avenida Grecia",
      house_number: "3000",
      suburb: "Nunoa",
      city: "Santiago",
      country_code: "cl",
    });
    expect(c.commune).toBe("Ñuñoa");
  });

  it("acepta mayúsculas y espacios sobrantes", () => {
    const c = mapOsmComponents({
      road: "Moneda",
      house_number: "1025",
      suburb: "  ESTACION CENTRAL ",
      country_code: "cl",
    });
    expect(c.commune).toBe("Estación Central");
  });

  it("el barrio sigue sin repetir a la comuna aunque difieran en una tilde", () => {
    const c = mapOsmComponents({
      road: "Avenida Grecia",
      suburb: "Nunoa",
      country_code: "cl",
    });
    expect(c.commune).toBe("Ñuñoa");
    expect(c.sublocality).toBeNull();
  });
});
