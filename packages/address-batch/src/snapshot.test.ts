import { describe, expect, it } from "vitest";
import { snapshotResultsForExport, type BatchSnapshot } from "./snapshot.ts";
import type { BatchInputRow, BatchResultRow } from "@allride/geo-core";

function inputRow(id: string, index: number): BatchInputRow {
  return { id, index, raw: `Calle ${index} 100`, query: `Calle ${index} 100` };
}

function done(row: BatchInputRow): BatchResultRow {
  return {
    row,
    status: "ok",
    value: {
      lat: -33.44, lng: -70.65, formatted: row.raw,
      components: { street: row.raw, number: "100", sublocality: null, commune: null, city: null, region: null, postalCode: null, country: "CL" },
      precision: "rooftop", source: "search", provider: "falso", capturedAt: "2026-08-15T12:00:00.000Z",
    },
    matchedLevel: "address",
    issues: [],
  };
}

function snapshot(rows: BatchInputRow[], results: BatchResultRow[]): BatchSnapshot {
  return { savedAt: new Date(), rows, results, sourceHeaders: null, done: results.length, total: rows.length };
}

describe("snapshotResultsForExport", () => {
  it("rellena con 'pendiente' las filas que no llegaron a resolverse", () => {
    const r1 = inputRow("r1", 1);
    const r2 = inputRow("r2", 2);
    const r3 = inputRow("r3", 3);
    const out = snapshotResultsForExport(snapshot([r1, r2, r3], [done(r1)]));

    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ row: r1, status: "ok" });
    expect(out[1]).toMatchObject({ row: r2, status: "pending", value: null });
    expect(out[2]).toMatchObject({ row: r3, status: "pending", value: null });
  });

  it("conserva el orden original de las filas, no el de los resultados guardados", () => {
    const r1 = inputRow("r1", 1);
    const r2 = inputRow("r2", 2);
    // Los resultados llegan en orden inverso al de las filas.
    const out = snapshotResultsForExport(snapshot([r1, r2], [done(r2), done(r1)]));
    expect(out.map((r) => r.row.id)).toEqual(["r1", "r2"]);
  });

  it("sin ninguna resuelta, todas quedan pendientes", () => {
    const rows = [inputRow("r1", 1), inputRow("r2", 2)];
    const out = snapshotResultsForExport(snapshot(rows, []));
    expect(out.every((r) => r.status === "pending")).toBe(true);
  });

  it("con todas resueltas, no aparece ningún placeholder", () => {
    const r1 = inputRow("r1", 1);
    const r2 = inputRow("r2", 2);
    const out = snapshotResultsForExport(snapshot([r1, r2], [done(r1), done(r2)]));
    expect(out.every((r) => r.status === "ok")).toBe(true);
  });
});
