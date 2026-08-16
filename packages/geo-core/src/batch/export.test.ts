import { describe, expect, it } from "vitest";
import { toClipboardText, toCsv, toDelimited, toExportTable, templateTable } from "./export.ts";
import { classifyResult, type BatchResultRow } from "./classify.ts";
import { buildRows, parseInputText } from "./parse.ts";
import type { GeocodeOutcome } from "../types.ts";

function hit(formatted: string, street: string, number: string | null, commune: string): GeocodeOutcome {
  return {
    matchedLevel: number ? "address" : "street",
    value: {
      lat: -33.429012,
      lng: -70.621103,
      formatted,
      components: {
        street, number, sublocality: null, commune,
        city: null, region: null, postalCode: null, country: "Chile",
      },
      precision: number ? "rooftop" : "street",
      source: "search",
      provider: "locationiq",
      capturedAt: new Date().toISOString(),
    },
  };
}

function sample(): BatchResultRow[] {
  const parsed = parseInputText("Nombre\tDirección\nAna\tAv. Providencia 1234\nLuis\tAv. Grecia 3000");
  const { rows } = buildRows(parsed);
  return [
    classifyResult(rows[0], hit("Avenida Providencia 1234, Providencia", "Avenida Providencia", "1234", "Providencia")),
    classifyResult(rows[1], hit("Av. Grecia, Ñuñoa", "Av. Grecia", null, "Peñalolén")),
  ];
}

describe("toExportTable", () => {
  it("devuelve las columnas originales intactas y agrega las del resultado", () => {
    const table = toExportTable(sample(), { sourceHeaders: ["Nombre", "Dirección"] });
    expect(table.headers.slice(0, 3)).toEqual(["#", "Nombre", "Dirección"]);
    expect(table.rows[0].slice(0, 3)).toEqual(["1", "Ana", "Av. Providencia 1234"]);
  });

  it("traduce el estado y explica el motivo en la fila incierta", () => {
    const table = toExportTable(sample(), { sourceHeaders: ["Nombre", "Dirección"] });
    const estado = table.headers.indexOf("Estado");
    const motivo = table.headers.indexOf("Motivo");
    expect(table.rows[0][estado]).toBe("Exitoso");
    expect(table.rows[0][motivo]).toBe("");
    expect(table.rows[1][estado]).toBe("Incierto");
    expect(table.rows[1][motivo]).toContain("altura");
  });

  it("las filas fallidas aparecen igual, marcadas y sin coordenadas", () => {
    const { rows } = buildRows({ kind: "lines", lines: ["Calle que no existe 99999"] });
    const table = toExportTable([classifyResult(rows[0], null)]);
    const lat = table.headers.indexOf("Latitud");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0][table.headers.indexOf("Estado")]).toBe("Fallido");
    expect(table.rows[0][lat]).toBe("");
  });

  it("distingue en el origen lo corregido a mano de lo que resolvió el proveedor", () => {
    const [buena, mala] = sample();
    const corregida = {
      ...mala,
      status: "corrected" as const,
      issues: [],
      correctedAt: new Date().toISOString(),
    };
    const table = toExportTable([buena, corregida]);
    const origen = table.headers.indexOf("Origen");
    expect(table.rows[0][origen]).toBe("locationiq");
    expect(table.rows[1][origen]).toBe("corregido a mano");
    expect(table.rows[1][table.headers.indexOf("Estado")]).toBe("Corregido");
  });

  it("marca las filas que copiaron a otra idéntica en vez de consultarse", () => {
    const [buena] = sample();
    const table = toExportTable([{ ...buena, fromDuplicate: true }]);
    expect(table.rows[0][table.headers.indexOf("Origen")]).toBe("copiado de fila idéntica");
  });

  it("usa coma decimal cuando se pide, para que Excel las lea como números", () => {
    const table = toExportTable(sample(), { decimalSeparator: "," });
    expect(table.rows[0][table.headers.indexOf("Latitud")]).toBe("-33,429012");
  });
});

describe("toDelimited", () => {
  it("entrecomilla lo que contiene el separador", () => {
    const text = toDelimited({ headers: ["a", "b"], rows: [["x, y", "z"]] }, { delimiter: "," });
    expect(text).toBe('a,b\r\n"x, y",z');
  });

  it("duplica las comillas internas", () => {
    const text = toDelimited({ headers: ["a"], rows: [['El "Bosque"']] });
    expect(text).toBe('a\r\n"El ""Bosque"""');
  });

  it("acepta punto y coma para el Excel en español", () => {
    const text = toDelimited({ headers: ["a", "b"], rows: [["1", "2"]] }, { delimiter: ";" });
    expect(text).toBe("a;b\r\n1;2");
  });
});

describe("toCsv", () => {
  it("antepone el BOM para que Excel no rompa las tildes", () => {
    expect(toCsv(sample()).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv(sample())).toContain("Peñalolén");
  });
});

describe("toClipboardText", () => {
  it("usa tabuladores y no lleva BOM: va directo a pegar", () => {
    const text = toClipboardText(sample(), { sourceHeaders: ["Nombre", "Dirección"] });
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.split("\r\n")[0].split("\t").slice(0, 3)).toEqual(["#", "Nombre", "Dirección"]);
  });

  it("cada fila pegada conserva sus columnas originales y su estado", () => {
    const text = toClipboardText(sample(), { sourceHeaders: ["Nombre", "Dirección"] });
    const [encabezado, primera, segunda] = text.split("\r\n");
    const columnas = encabezado.split("\t");
    const celdas = primera.split("\t");
    expect(celdas[columnas.indexOf("Nombre")]).toBe("Ana");
    expect(celdas[columnas.indexOf("Estado")]).toBe("Exitoso");
    expect(celdas[columnas.indexOf("Latitud")]).toBe("-33.429012");
    expect(segunda.split("\t")[columnas.indexOf("Estado")]).toBe("Incierto");
  });

  it("aplica el separador decimal pedido, para que Excel lea números", () => {
    const text = toClipboardText(sample(), { decimalSeparator: "," });
    const columnas = text.split("\r\n")[0].split("\t");
    expect(text.split("\r\n")[1].split("\t")[columnas.indexOf("Latitud")]).toBe("-33,429012");
  });

  it("una celda con tabulador o salto de línea no rompe la grilla al pegar", () => {
    const [buena] = sample();
    const raro = { ...buena, row: { ...buena.row, raw: "Calle con\ttabulador\ny salto" } };
    const text = toClipboardText([raro]);
    // Entrecomillada, la celda entra completa en una sola columna.
    expect(text).toContain('"Calle con\ttabulador\ny salto"');
    expect(text.split("\r\n")[0].split("\t")).toHaveLength(
      toClipboardText([buena]).split("\r\n")[0].split("\t").length,
    );
  });
});

describe("templateTable", () => {
  it("la plantilla libre trae direcciones reales, no relleno", () => {
    const table = templateTable("libre");
    expect(table.headers).toEqual(["Nombre", "Dirección"]);
    expect(table.rows[0][1]).toContain("Providencia");
  });

  it("la plantilla estructurada separa calle y número", () => {
    const table = templateTable("estructurada");
    expect(table.headers).toContain("Número");
    expect(table.rows[0]).toContain("1234");
  });

  it("las plantillas se pueden volver a leer con el mismo parser", () => {
    const table = templateTable("estructurada");
    const csv = toDelimited(table, { delimiter: "\t" });
    const parsed = parseInputText(csv);
    const { rows } = buildRows(parsed);
    expect(rows).toHaveLength(3);
    expect(rows[0].query).toBe("Av. Providencia 1234, Santiago, Región Metropolitana");
    expect(rows[0].adminArea).toEqual({ name: "Providencia", parentName: "Región Metropolitana" });
  });
});
