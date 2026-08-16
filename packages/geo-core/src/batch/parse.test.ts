import { describe, expect, it } from "vitest";
import { buildRows, composeQuery, guessMapping, parseDelimited, parseInputText } from "./parse.ts";

describe("parseDelimited", () => {
  it("respeta comillas con el separador adentro", () => {
    expect(parseDelimited('nombre,direccion\nAna,"Av. Providencia 1234, Providencia"', ",")).toEqual([
      ["nombre", "direccion"],
      ["Ana", "Av. Providencia 1234, Providencia"],
    ]);
  });

  it("respeta saltos de línea dentro de una celda", () => {
    const rows = parseDelimited('A\t"linea uno\nlinea dos"\nB\tsimple', "\t");
    expect(rows).toEqual([
      ["A", "linea uno\nlinea dos"],
      ["B", "simple"],
    ]);
  });

  it("interpreta la comilla doble como comilla literal", () => {
    expect(parseDelimited('"El ""Bosque"" 100"\t x', "\t")).toEqual([['El "Bosque" 100', "x"]]);
  });

  it("trata \\r\\n como un solo fin de fila", () => {
    expect(parseDelimited("a,b\r\nc,d", ",")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseInputText", () => {
  it("una dirección por línea queda como líneas", () => {
    const parsed = parseInputText("Av. Providencia 1234\nAv. Grecia 3000\n\n");
    expect(parsed).toEqual({ kind: "lines", lines: ["Av. Providencia 1234", "Av. Grecia 3000"] });
  });

  it("no confunde las comas de una dirección con columnas", () => {
    const parsed = parseInputText("Av. Providencia 1234, Providencia, Santiago");
    expect(parsed).toEqual({ kind: "lines", lines: ["Av. Providencia 1234, Providencia, Santiago"] });
  });

  it("varias líneas con comas siguen siendo direcciones, no una tabla", () => {
    const parsed = parseInputText(
      "Av. Providencia 1234, Providencia, Santiago\nAv. Grecia 3000, Ñuñoa, Santiago",
    );
    expect(parsed).toEqual({
      kind: "lines",
      lines: ["Av. Providencia 1234, Providencia, Santiago", "Av. Grecia 3000, Ñuñoa, Santiago"],
    });
  });

  it("con coma sí es tabla cuando hay encabezados reconocibles", () => {
    const parsed = parseInputText("Nombre,Dirección,Comuna\nAna,Av. Providencia 1234,Providencia");
    expect(parsed.kind === "table" && parsed.headers).toEqual(["Nombre", "Dirección", "Comuna"]);
  });

  it("el punto y coma es siempre tabla: no aparece dentro de una dirección", () => {
    const parsed = parseInputText("Ana;Av. Providencia 1234\nLuis;Av. Grecia 3000");
    expect(parsed.kind === "table" && parsed.rows).toEqual([
      ["Ana", "Av. Providencia 1234"],
      ["Luis", "Av. Grecia 3000"],
    ]);
  });

  it("un CSV cargado se puede forzar a tabla aunque no traiga encabezados", () => {
    const parsed = parseInputText("Ana,Av. Providencia 1234\nLuis,Av. Grecia 3000", { assume: "table" });
    expect(parsed.kind === "table" && parsed.rows).toHaveLength(2);
  });

  it("quita las comillas de un CSV de una sola columna", () => {
    const parsed = parseInputText('"Av. Providencia 1234, Providencia"\n"Av. Grecia 3000, Ñuñoa"');
    expect(parsed).toEqual({
      kind: "lines",
      lines: ["Av. Providencia 1234, Providencia", "Av. Grecia 3000, Ñuñoa"],
    });
  });

  it("celdas pegadas de Excel se leen como tabla con encabezados", () => {
    const parsed = parseInputText("Nombre\tDirección\tComuna\nAna\tAv. Providencia 1234\tProvidencia");
    expect(parsed).toEqual({
      kind: "table",
      delimiter: "\t",
      headers: ["Nombre", "Dirección", "Comuna"],
      rows: [["Ana", "Av. Providencia 1234", "Providencia"]],
    });
  });

  it("sin encabezados reconocibles, la primera fila ya son datos", () => {
    const parsed = parseInputText("Ana\tAv. Providencia 1234\nLuis\tAv. Grecia 3000");
    expect(parsed.kind === "table" && parsed.headers).toBe(null);
    expect(parsed.kind === "table" && parsed.rows.length).toBe(2);
  });

  it("una sola columna vuelve a ser una lista de líneas", () => {
    const parsed = parseInputText("Av. Providencia 1234\nAv. Grecia 3000");
    expect(parsed.kind).toBe("lines");
  });

  it("quita el BOM que anteponen Excel y varios exportadores", () => {
    const parsed = parseInputText("﻿Dirección;Comuna\nAv. Providencia 1234;Providencia");
    expect(parsed.kind === "table" && parsed.headers).toEqual(["Dirección", "Comuna"]);
  });

  it("rellena filas cortas para no desalinear columnas", () => {
    const parsed = parseInputText("Nombre\tDirección\tComuna\nAna\tAv. Providencia 1234");
    expect(parsed.kind === "table" && parsed.rows[0]).toEqual(["Ana", "Av. Providencia 1234", ""]);
  });
});

describe("guessMapping", () => {
  it("reconoce encabezados en español con tildes", () => {
    expect(guessMapping(["Nombre", "Dirección", "Comuna", "Región", "Notas"])).toEqual([
      "label",
      "address",
      "district",
      "region",
      "ignore",
    ]);
  });

  it("ignora la segunda columna del mismo rol en vez de pisar la primera", () => {
    expect(guessMapping(["Ciudad", "City"])).toEqual(["city", "ignore"]);
  });
});

describe("composeQuery", () => {
  it("deja la comuna fuera del texto: viaja como dato estructurado", () => {
    const query = composeQuery({ street: "Av. Grecia", number: "3000", district: "Ñuñoa" });
    expect(query).toBe("Av. Grecia 3000");
  });

  it("las opciones generales completan lo que la fila no trae", () => {
    const query = composeQuery({ street: "Av. Grecia", number: "3000" }, { city: "Santiago" });
    expect(query).toBe("Av. Grecia 3000, Santiago");
  });
});

describe("buildRows", () => {
  it("numera con el índice original de la planilla", () => {
    const { rows, emptyRows } = buildRows({ kind: "lines", lines: ["Av. Providencia 1234", "", "Av. Grecia 3000"] });
    expect(rows.map((r) => r.index)).toEqual([1, 3]);
    expect(emptyRows).toBe(1);
  });

  it("saca la comuna del query y la manda como adminArea", () => {
    const parsed = parseInputText("Calle\tNúmero\tComuna\nAv. Grecia\t3000\tÑuñoa");
    const { rows } = buildRows(parsed);
    expect(rows[0].query).toBe("Av. Grecia 3000");
    expect(rows[0].adminArea).toEqual({ name: "Ñuñoa" });
  });

  it("usa la región como división superior de la comuna", () => {
    const parsed = parseInputText("Calle\tComuna\tRegión\nAv. Grecia\tÑuñoa\tRM");
    const { rows } = buildRows(parsed);
    expect(rows[0].adminArea).toEqual({ name: "Ñuñoa", parentName: "RM" });
  });

  it("marca duplicados para no gastar una consulta por cada uno", () => {
    const { rows, duplicates } = buildRows({
      kind: "lines",
      lines: ["Av. Providencia 1234", "AV. PROVIDENCIA 1234", "Av. Grecia 3000"],
    });
    expect(duplicates).toBe(1);
    expect(rows[1].duplicateOf).toBe(rows[0].id);
    expect(rows[2].duplicateOf).toBeUndefined();
  });

  it("no repite la ciudad si la persona ya la escribió", () => {
    const { rows } = buildRows(
      { kind: "lines", lines: ["Av. Providencia 1234, Santiago", "Av. Grecia 3000"] },
      { defaults: { city: "Santiago" } },
    );
    expect(rows[0].query).toBe("Av. Providencia 1234, Santiago");
    expect(rows[1].query).toBe("Av. Grecia 3000, Santiago");
  });

  it("recorta al tope configurado y reporta cuánto quedó fuera", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Calle ${i} 100`);
    const { rows, droppedOverLimit } = buildRows({ kind: "lines", lines }, { maxRows: 3 });
    expect(rows).toHaveLength(3);
    expect(droppedOverLimit).toBe(2);
  });

  it("sin tope no recorta nada", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `Calle ${i} 100`);
    const { rows, droppedOverLimit } = buildRows({ kind: "lines", lines });
    expect(rows).toHaveLength(500);
    expect(droppedOverLimit).toBe(0);
  });

  it("conserva las celdas originales para poder devolverlas al exportar", () => {
    const parsed = parseInputText("Nombre\tDirección\nAna\tAv. Providencia 1234");
    const { rows, sourceHeaders } = buildRows(parsed);
    expect(sourceHeaders).toEqual(["Nombre", "Dirección"]);
    expect(rows[0].cells).toEqual(["Ana", "Av. Providencia 1234"]);
  });

  it("sin encabezados elige la columna que parece dirección", () => {
    const parsed = parseInputText("Ana\tAv. Providencia 1234\nLuis\tAv. Grecia 3000");
    const { rows } = buildRows(parsed);
    expect(rows.map((r) => r.query)).toEqual(["Av. Providencia 1234", "Av. Grecia 3000"]);
  });
});

describe("limpieza del texto de consulta", () => {
  it("consulta lo limpio pero muestra y exporta lo escrito", () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: ["Av. Apoquindo N° 4501, depto 902, Las Condes"],
    });
    expect(rows[0].raw).toBe("Av. Apoquindo N° 4501, depto 902, Las Condes");
    expect(rows[0].query).toBe("Av. Apoquindo 4501, Las Condes");
  });

  it("dos deptos del mismo edificio son una sola consulta", () => {
    // El punto del edificio no cambia con el piso: la segunda fila hereda.
    const { rows, duplicates } = buildRows({
      kind: "lines",
      lines: ["Av. Grecia 3000 depto 42, Ñuñoa", "Av. Grecia 3000 depto 51, Ñuñoa"],
    });
    expect(duplicates).toBe(1);
    expect(rows[1].duplicateOf).toBe(rows[0].id);
  });

  it("limpia también la columna Número de una planilla", () => {
    const { rows } = buildRows({
      kind: "table",
      delimiter: ",",
      headers: ["Calle", "Número", "Comuna"],
      rows: [["Av. Apoquindo", "N° 4501", "Las Condes"]],
    });
    expect(rows[0].query).toBe("Av. Apoquindo 4501");
    expect(rows[0].adminArea?.name).toBe("Las Condes");
  });
})
