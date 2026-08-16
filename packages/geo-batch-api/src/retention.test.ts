import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./memory-store.ts";
import { runRetentionLoop } from "./retention.ts";
import type { BatchJob, StoredRow } from "./types.ts";
import type { BatchStore } from "./store.ts";

const AHORA = "2026-08-15T12:00:00.000Z";
const VENCIDO = "2026-08-01T00:00:00.000Z";

function job(over: Partial<BatchJob> = {}): BatchJob {
  return {
    id: "job_1",
    tenantId: "cliente_a",
    status: "done",
    createdAt: AHORA,
    expiresAt: VENCIDO,
    bias: { country: "CL" },
    sourceHeaders: null,
    rowCount: 1,
    summary: { total: 1, ok: 1, uncertain: 0, failed: 0, corrected: 0, pending: 0 },
    queries: 1,
    ...over,
  };
}

function row(): StoredRow {
  return {
    jobId: "job_1",
    updatedAt: AHORA,
    row: { id: "r1", index: 1, raw: "Calle 1 100", query: "Calle 1 100" },
    status: "ok",
    value: null,
    matchedLevel: null,
    issues: [],
  };
}

async function conTrabajoVencido(): Promise<BatchStore> {
  const store = createMemoryStore();
  await store.createJob(job(), [row()]);
  return store;
}

describe("runRetentionLoop", () => {
  it("purga al arrancar, sin esperar el primer intervalo", async () => {
    const store = await conTrabajoVencido();
    const controller = new AbortController();
    const purgas: number[] = [];

    const loop = runRetentionLoop({
      store,
      intervalMs: 10_000, // deliberadamente largo: si esperara al intervalo, el assert de abajo fallaría
      signal: controller.signal,
      onPurge: (n) => purgas.push(n),
    });

    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await loop;

    expect(purgas[0]).toBe(1);
    expect(await store.getJob("cliente_a", "job_1")).toBeNull();
  });

  it("sigue purgando en cada intervalo hasta abortar", async () => {
    const store = createMemoryStore();
    const controller = new AbortController();
    const purgas: number[] = [];

    const loop = runRetentionLoop({
      store,
      intervalMs: 10,
      signal: controller.signal,
      onPurge: (n) => purgas.push(n),
    });

    await new Promise((r) => setTimeout(r, 55));
    controller.abort();
    await loop;

    // Con nada que purgar cada vuelta reporta 0, pero se espera que haya
    // corrido varias veces en ~55ms con un intervalo de 10ms.
    expect(purgas.length).toBeGreaterThanOrEqual(3);
    expect(purgas.every((n) => n === 0)).toBe(true);
  });

  it("un error de purgeExpired se reporta por onError y el loop sigue", async () => {
    const store = createMemoryStore();
    const original = store.purgeExpired;
    let llamadas = 0;
    store.purgeExpired = async (now) => {
      llamadas += 1;
      if (llamadas === 1) throw new Error("se cayó la base");
      return original.call(store, now);
    };

    const controller = new AbortController();
    const errores: unknown[] = [];
    const purgas: number[] = [];

    const loop = runRetentionLoop({
      store,
      intervalMs: 10,
      signal: controller.signal,
      onError: (err) => errores.push(err),
      onPurge: (n) => purgas.push(n),
    });

    await new Promise((r) => setTimeout(r, 35));
    controller.abort();
    await loop;

    expect(errores).toHaveLength(1);
    expect((errores[0] as Error).message).toBe("se cayó la base");
    // La primera vuelta falló y no llamó a onPurge; las siguientes sí.
    expect(purgas.length).toBeGreaterThanOrEqual(1);
  });

  it("con el signal ya abortado, no purga ni una vez", async () => {
    const store = await conTrabajoVencido();
    const controller = new AbortController();
    controller.abort();
    const purgas: number[] = [];

    await runRetentionLoop({ store, signal: controller.signal, onPurge: (n) => purgas.push(n) });

    expect(purgas).toEqual([]);
    // El trabajo vencido sigue ahí: el loop nunca corrió el cuerpo.
    expect(await store.getJob("cliente_a", "job_1")).not.toBeNull();
  });
});
