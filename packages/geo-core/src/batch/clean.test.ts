import { describe, expect, it } from "vitest";
import { cleanQuery } from "./clean.ts";

/** Atajo: solo el texto resultante. */
const limpio = (text: string) => cleanQuery(text).query;

describe("prefijo de número", () => {
  it.each([
    ["Av. Apoquindo N° 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo Nº 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo N°4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo No. 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo Nro. 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo Nro 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo Núm. 4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo #4501", "Av. Apoquindo 4501"],
    ["Av. Apoquindo # 4501", "Av. Apoquindo 4501"],
  ])("%s → %s", (entrada, esperado) => {
    expect(limpio(entrada)).toBe(esperado);
  });

  it("una N sola no es un prefijo: puede ser el nombre de la calle", () => {
    // "Pasaje N 12" es el 12 del Pasaje N, no el número 12 de "Pasaje".
    expect(limpio("Pasaje N 12, La Florida")).toBe("Pasaje N 12, La Florida");
  });

  it("no toca un número que ya venía limpio", () => {
    expect(limpio("Av. Apoquindo 4501")).toBe("Av. Apoquindo 4501");
  });
});

describe("marcadores de unidad", () => {
  it.each([
    ["Av. Grecia 3000 depto 42", "Av. Grecia 3000"],
    ["Av. Grecia 3000, Depto. 42", "Av. Grecia 3000"],
    ["Av. Grecia 3000 dpto 42", "Av. Grecia 3000"],
    ["Av. Grecia 3000, of. 301", "Av. Grecia 3000"],
    ["Av. Grecia 3000, oficina 301", "Av. Grecia 3000"],
    ["Av. Grecia 3000 block 3", "Av. Grecia 3000"],
    ["Av. Grecia 3000, torre B depto 902", "Av. Grecia 3000"],
    ["Av. Grecia 3000 piso 4 oficina 12", "Av. Grecia 3000"],
    ["Av. Grecia 3000, local 5", "Av. Grecia 3000"],
    ["Av. Grecia 3000, interior 2", "Av. Grecia 3000"],
    ["Av. Grecia 3000, casa B", "Av. Grecia 3000"],
  ])("%s → %s", (entrada, esperado) => {
    expect(limpio(entrada)).toBe(esperado);
  });

  it("conserva la comuna que viene después del depto", () => {
    expect(limpio("Av. Grecia 3000 depto 42, Ñuñoa")).toBe("Av. Grecia 3000, Ñuñoa");
  });

  it("informa qué sacó", () => {
    expect(cleanQuery("Av. Grecia 3000, torre B depto 902").removed).toEqual(["torre B", "depto 902"]);
  });
});

describe("lo que no hay que romper", () => {
  it("una palabra de verdad no es el valor de una unidad", () => {
    // "Casa de Moneda" perdería el nombre si "casa" se comiera lo que sigue.
    expect(limpio("Villa Casa de Moneda, Maipú")).toBe("Villa Casa de Moneda, Maipú");
  });

  it("respeta nombres de calle que empiezan con un marcador", () => {
    expect(limpio("Casa Blanca 220, Colina")).toBe("Casa Blanca 220, Colina");
    expect(limpio("Los Pisos 1200")).toBe("Los Pisos 1200");
  });

  it("una población sin ninguna calle a la vista se queda como está", () => {
    expect(limpio("Población La Victoria, Pedro Aguirre Cerda")).toBe(
      "Población La Victoria, Pedro Aguirre Cerda",
    );
  });

  it("no deja el texto sin nada que buscar", () => {
    expect(limpio("depto 42")).toBe("depto 42");
    expect(limpio("block 3")).toBe("block 3");
  });

  it("deja intacta una dirección que no tiene ruido", () => {
    const direccion = "Av. Libertador Bernardo O'Higgins 1449, Santiago";
    expect(limpio(direccion)).toBe(direccion);
    expect(cleanQuery(direccion).removed).toEqual([]);
  });

  it("no cambia una dirección con tildes ni la parte por la mitad", () => {
    expect(limpio("Av. Vicuña Mackenna 4860, Peñalolén")).toBe(
      "Av. Vicuña Mackenna 4860, Peñalolén",
    );
  });
});

describe("cuando la unidad es la altura", () => {
  /*
   * En un pasaje de población el número de casa es la dirección. Borrarlo
   * dejaría al geocoder buscando un pasaje entero.
   */
  it("degrada en vez de borrar si no queda otra altura", () => {
    expect(limpio("Pasaje Los Aromos casa 12, Puente Alto")).toBe(
      "Pasaje Los Aromos 12, Puente Alto",
    );
  });

  it("borra cuando sí hay otra altura", () => {
    expect(limpio("Pasaje Los Aromos 340 casa 12, Puente Alto")).toBe(
      "Pasaje Los Aromos 340, Puente Alto",
    );
  });

  it("una letra no sirve de altura: se borra igual", () => {
    expect(limpio("Pasaje Los Aromos casa B, Puente Alto")).toBe(
      "Pasaje Los Aromos, Puente Alto",
    );
  });
});

describe("nombre de villa o población", () => {
  it("lo saca cuando hay una calle de nombre propio con altura", () => {
    // Medido: anteponer una villa mandó 4 de 20 consultas a más de 40 km.
    expect(limpio("Villa Los Presidentes, Avenida Apoquindo 4335, Santiago")).toBe(
      "Avenida Apoquindo 4335, Santiago",
    );
    expect(limpio("Av. Grecia 3000, Villa Olímpica, Ñuñoa")).toBe("Av. Grecia 3000, Ñuñoa");
    expect(limpio("Condominio Los Robles, Camino El Alba 11000, Las Condes")).toBe(
      "Camino El Alba 11000, Las Condes",
    );
  });

  it("lo conserva cuando la calle es un pasaje numerado sin nombre", () => {
    expect(limpio("Villa Los Aromos, Pasaje 3, Puente Alto")).toBe(
      "Villa Los Aromos, Pasaje 3, Puente Alto",
    );
  });

  it("lo conserva cuando no hay ninguna calle con altura", () => {
    expect(limpio("Villa Los Aromos, Puente Alto")).toBe("Villa Los Aromos, Puente Alto");
  });

  it("no confunde una comuna que se llama Villa con un loteo", () => {
    expect(limpio("Av. Valparaíso 220, Villa Alemana")).toBe("Av. Valparaíso 220, Villa Alemana");
    expect(limpio("Calle Comercio 150, Villa Alegre")).toBe("Calle Comercio 150, Villa Alegre");
  });

  it("no toca un nombre de calle que empieza con Villa", () => {
    // "Villa" acá es parte del nombre, y el trozo trae su propia altura.
    expect(limpio("Villa Rica 1200, Temuco")).toBe("Villa Rica 1200, Temuco");
  });
})
