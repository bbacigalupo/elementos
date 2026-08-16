import { describe, expect, it } from "vitest";
import { createMemoryStore } from "./memory-store.ts";
import { generateApiKey, hashApiKey, looksLikeApiKey, timingSafeEqual } from "./keys.ts";
import type { BatchJob, StoredRow } from "./types.ts";
import type { BatchStore } from "./store.ts";

const AHORA = "2026-08-15T12:00:00.000Z";

function job(over: Partial<BatchJob> = {}): BatchJob {
  return {
    id: "job_1",
    tenantId: "cliente_a",
    status: "pending",
    createdAt: AHORA,
    expiresAt: "2026-09-14T12:00:00.000Z",
    bias: { country: "CL" },
    sourceHeaders: null,
    rowCount: 2,
    summary: { total: 2, ok: 0, uncertain: 0, failed: 0, corrected: 0, pending: 2 },
    queries: 0,
    ...over,
  };
}

function row(jobId: string, id: string, index: number): StoredRow {
  return {
    jobId,
    updatedAt: AHORA,
    row: { id, index, raw: `Calle ${index} 100`, query: `Calle ${index} 100` },
    status: "pending",
    value: null,
    matchedLevel: null,
    issues: [],
  };
}

async function conTrabajo(): Promise<BatchStore> {
  const store = createMemoryStore();
  await store.createJob(job(), [row("job_1", "r1", 1), row("job_1", "r2", 2)]);
  return store;
}

describe("aislamiento entre clientes", () => {
  it("un cliente no ve el trabajo de otro", async () => {
    const store = await conTrabajo();
    expect(await store.getJob("cliente_a", "job_1")).not.toBeNull();
    expect(await store.getJob("cliente_b", "job_1")).toBeNull();
  });

  it("un cliente no ve las filas de otro, ni sabiendo el id del trabajo", async () => {
    const store = await conTrabajo();
    expect((await store.listRows("cliente_a", "job_1")).total).toBe(2);
    expect((await store.listRows("cliente_b", "job_1")).total).toBe(0);
    expect(await store.getRow("cliente_b", "job_1", "r1")).toBeNull();
  });

  it("un cliente no puede borrar el trabajo de otro", async () => {
    const store = await conTrabajo();
    expect(await store.deleteJob("cliente_b", "job_1")).toBe(false);
    expect(await store.getJob("cliente_a", "job_1")).not.toBeNull();
    expect(await store.deleteJob("cliente_a", "job_1")).toBe(true);
  });

  it("un parche no puede mover un trabajo de un cliente a otro", async () => {
    const store = await conTrabajo();
    await store.updateJob("job_1", { tenantId: "cliente_b", status: "done" } as Partial<BatchJob>);
    expect(await store.getJob("cliente_b", "job_1")).toBeNull();
    expect((await store.getJob("cliente_a", "job_1"))?.status).toBe("done");
  });

  it("lo leído es una copia: mutarlo no toca lo guardado", async () => {
    const store = await conTrabajo();
    const leido = await store.getJob("cliente_a", "job_1");
    leido!.status = "done";
    expect((await store.getJob("cliente_a", "job_1"))?.status).toBe("pending");
  });
});

describe("idempotencia", () => {
  it("encuentra el trabajo previo por la clave del cliente", async () => {
    const store = createMemoryStore();
    await store.createJob(job({ idempotencyKey: "nomina-agosto" }), []);
    expect((await store.findByIdempotencyKey("cliente_a", "nomina-agosto"))?.id).toBe("job_1");
  });

  it("la clave de un cliente no colisiona con la del mismo nombre de otro", async () => {
    const store = createMemoryStore();
    await store.createJob(job({ idempotencyKey: "nomina-agosto" }), []);
    expect(await store.findByIdempotencyKey("cliente_b", "nomina-agosto")).toBeNull();
  });
});

describe("reclamo de trabajos por el worker", () => {
  it("dos workers no se llevan el mismo trabajo", async () => {
    const store = await conTrabajo();
    expect((await store.claimNextJob("worker-1", 60_000))?.id).toBe("job_1");
    expect(await store.claimNextJob("worker-2", 60_000)).toBeNull();
  });

  it("rescata el trabajo de un worker cuyo arriendo venció", async () => {
    const store = createMemoryStore();
    await store.createJob(
      job({
        status: "running",
        workerId: "worker-caido",
        leaseUntil: new Date(Date.now() - 1000).toISOString(),
      }),
      [],
    );
    const rescatado = await store.claimNextJob("worker-2", 60_000);
    expect(rescatado?.workerId).toBe("worker-2");
  });

  it("el heartbeat falla si otro worker se quedó con el trabajo", async () => {
    const store = await conTrabajo();
    await store.claimNextJob("worker-1", 60_000);
    expect(await store.heartbeat("job_1", "worker-1", 60_000)).toBe(true);
    expect(await store.heartbeat("job_1", "worker-2", 60_000)).toBe(false);
  });

  it("toma primero el trabajo más antiguo", async () => {
    const store = createMemoryStore();
    await store.createJob(job({ id: "job_nuevo", createdAt: "2026-08-15T13:00:00.000Z" }), []);
    await store.createJob(job({ id: "job_viejo", createdAt: "2026-08-15T11:00:00.000Z" }), []);
    expect((await store.claimNextJob("w", 60_000))?.id).toBe("job_viejo");
  });
});

describe("filas", () => {
  it("guardar una fila la reemplaza, no la duplica", async () => {
    const store = await conTrabajo();
    await store.saveRows([{ ...row("job_1", "r1", 1), status: "ok" }]);
    const { rows, total } = await store.listRows("cliente_a", "job_1");
    expect(total).toBe(2);
    expect(rows.find((r) => r.row.id === "r1")?.status).toBe("ok");
  });

  it("filtra por estado y pagina, informando el total del filtro", async () => {
    const store = await conTrabajo();
    await store.saveRows([
      { ...row("job_1", "r1", 1), status: "uncertain" },
      { ...row("job_1", "r2", 2), status: "ok" },
    ]);
    const soloInciertas = await store.listRows("cliente_a", "job_1", { status: ["uncertain"] });
    expect(soloInciertas).toMatchObject({ total: 1 });
    expect(soloInciertas.rows[0].row.id).toBe("r1");

    const pagina = await store.listRows("cliente_a", "job_1", { limit: 1, offset: 1 });
    expect(pagina.total).toBe(2);
    expect(pagina.rows).toHaveLength(1);
    expect(pagina.rows[0].row.index).toBe(2);
  });
});

describe("retención", () => {
  it("purgeExpired borra lo vencido y deja lo vigente", async () => {
    const store = createMemoryStore();
    await store.createJob(job({ id: "vencido", expiresAt: "2026-08-01T00:00:00.000Z" }), [
      row("vencido", "r1", 1),
    ]);
    await store.createJob(job({ id: "vigente", expiresAt: "2026-12-01T00:00:00.000Z" }), []);

    expect(await store.purgeExpired(new Date(AHORA))).toBe(1);
    expect(await store.getJob("cliente_a", "vencido")).toBeNull();
    expect(await store.getJob("cliente_a", "vigente")).not.toBeNull();
  });

  it("borrar un trabajo se lleva también sus filas", async () => {
    const store = createMemoryStore();
    await store.createJob(job(), [row("job_1", "r1", 1)]);
    expect(store.snapshot().rows).toBe(1);
    await store.deleteJob("cliente_a", "job_1");
    expect(store.snapshot().rows).toBe(0);
  });

  it("purgeTenant borra todo lo de un cliente y nada de los demás", async () => {
    const store = createMemoryStore();
    await store.createJob(job({ id: "a1" }), [row("a1", "r1", 1)]);
    await store.createJob(job({ id: "b1", tenantId: "cliente_b" }), [row("b1", "r1", 1)]);

    expect(await store.purgeTenant("cliente_a")).toBe(1);
    expect(await store.getJob("cliente_a", "a1")).toBeNull();
    expect(await store.getJob("cliente_b", "b1")).not.toBeNull();
  });
});

describe("consumo", () => {
  it("acumula por cliente desde un momento dado", async () => {
    const store = createMemoryStore();
    const ayer = new Date("2026-08-14T12:00:00.000Z");
    const hoy = new Date(AHORA);
    await store.recordUsage("cliente_a", 100, ayer);
    await store.recordUsage("cliente_a", 40, hoy);
    await store.recordUsage("cliente_b", 999, hoy);

    expect(await store.usageSince("cliente_a", ayer)).toBe(140);
    expect(await store.usageSince("cliente_a", hoy)).toBe(40);
    expect(await store.usageSince("cliente_b", hoy)).toBe(999);
  });
});

describe("claves de API", () => {
  it("la clave generada tiene la forma esperada y es distinta cada vez", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(looksLikeApiKey(a)).toBe(true);
    expect(a.startsWith("ark_live_")).toBe(true);
    expect(a).not.toBe(b);
    expect(looksLikeApiKey(generateApiKey("test"))).toBe(true);
  });

  it("rechaza cualquier cosa que no tenga forma de clave nuestra", () => {
    expect(looksLikeApiKey("Bearer abc")).toBe(false);
    expect(looksLikeApiKey("ark_live_corta")).toBe(false);
    expect(looksLikeApiKey("sk_live_" + "a".repeat(64))).toBe(false);
  });

  it("el hash es estable y no contiene la clave", async () => {
    const key = generateApiKey();
    const hash = await hashApiKey(key);
    expect(hash).toHaveLength(64);
    expect(hash).toBe(await hashApiKey(key));
    expect(hash).not.toContain(key.slice(9));
  });

  it("se busca por hash, nunca por la clave en claro", async () => {
    const store = createMemoryStore();
    const key = generateApiKey();
    store.addApiKey({
      id: "key_1",
      tenantId: "cliente_a",
      keyHash: await hashApiKey(key),
      name: "ERP de nóminas",
      scopes: ["batches:write", "batches:read"],
      dailyQuota: 5000,
      createdAt: AHORA,
    });

    expect((await store.findApiKeyByHash(await hashApiKey(key)))?.tenantId).toBe("cliente_a");
    expect(await store.findApiKeyByHash(key)).toBeNull();
  });

  it("la comparación en tiempo constante distingue bien", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
