import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { processNextJob, runWorkerLoop } from "./worker.ts";
import type { BatchJob, StoredRow } from "./types.ts";
import type { GeoBias, GeoClient, GeocodeOutcome } from "@allride/geo-core";

const AHORA = "2026-08-15T12:00:00.000Z";
const BIAS: GeoBias = { country: "CL" };

function hit(query: string): GeocodeOutcome {
  return {
    matchedLevel: "address",
    value: {
      lat: -33.44,
      lng: -70.65,
      formatted: query,
      components: {
        street: query, number: "100", sublocality: null, commune: null,
        city: null, region: null, postalCode: null, country: "CL",
      },
      precision: "rooftop",
      source: "search",
      provider: "falso",
      capturedAt: AHORA,
    },
  };
}

function fakeClient(handler: (query: string, i: number) => GeocodeOutcome | null | Promise<GeocodeOutcome | null>) {
  const calls: string[] = [];
  const client: GeoClient = {
    autocomplete: async () => [],
    reverse: async () => null,
    async geocode(query) {
      const i = calls.length;
      calls.push(query);
      return handler(query, i);
    },
  };
  return { client, calls };
}

function job(over: Partial<BatchJob> = {}): BatchJob {
  return {
    id: "job_1",
    tenantId: "cliente_a",
    status: "pending",
    createdAt: AHORA,
    expiresAt: "2026-09-14T12:00:00.000Z",
    bias: BIAS,
    sourceHeaders: null,
    rowCount: 3,
    summary: { total: 3, ok: 0, uncertain: 0, failed: 0, corrected: 0, pending: 3 },
    queries: 0,
    ...over,
  };
}

function row(jobId: string, id: string, index: number, over: Partial<StoredRow> = {}): StoredRow {
  return {
    jobId,
    updatedAt: AHORA,
    row: { id, index, raw: `Calle ${index} 100`, query: `Calle ${index} 100` },
    status: "pending",
    value: null,
    matchedLevel: null,
    issues: [],
    ...over,
  };
}

async function conTrabajo(rows: StoredRow[], jobOver: Partial<BatchJob> = {}): Promise<MemoryStore> {
  const store = createMemoryStore();
  await store.createJob(job({ rowCount: rows.length, ...jobOver }), rows);
  return store;
}

describe("processNextJob", () => {
  it("no hay nada para reclamar", async () => {
    const store = createMemoryStore();
    const { client } = fakeClient((q) => hit(q));
    const outcome = await processNextJob({ store, client });
    expect(outcome).toEqual({ claimed: false });
  });

  it("procesa un trabajo completo y lo deja 'done'", async () => {
    const rows = [row("job_1", "r1", 1), row("job_1", "r2", 2)];
    const store = await conTrabajo(rows);
    const { client, calls } = fakeClient((q) => hit(q));

    const outcome = await processNextJob({ store, client });

    expect(calls).toHaveLength(2);
    expect(outcome.claimed).toBe(true);
    expect(outcome.job?.status).toBe("done");
    expect(outcome.result?.summary).toMatchObject({ total: 2, ok: 2, pending: 0 });

    const stored = await store.getJob("cliente_a", "job_1");
    expect(stored?.status).toBe("done");
    expect(stored?.finishedAt).toBeDefined();
    expect(stored?.queries).toBe(2);

    const { rows: filas } = await store.listRows("cliente_a", "job_1");
    expect(filas.every((f) => f.status === "ok")).toBe(true);
  });

  it("registra el consumo del cliente, para que la cuota lo vea", async () => {
    const rows = [row("job_1", "r1", 1), row("job_1", "r2", 2)];
    const store = await conTrabajo(rows);
    const { client } = fakeClient((q) => hit(q));

    const antes = new Date("2026-08-14T00:00:00.000Z");
    await processNextJob({ store, client });

    expect(await store.usageSince("cliente_a", antes)).toBe(2);
  });

  it("guarda el avance en varios lotes, no solo al final", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => row("job_1", `r${i + 1}`, i + 1));
    const store = await conTrabajo(rows);
    const { client } = fakeClient((q) => hit(q));
    const espia = vi.spyOn(store, "saveRows");

    await processNextJob({ store, client, saveEveryRows: 2, concurrency: 1 });

    // Con 6 filas y lotes de 2: al menos 2 llamadas antes del flush final.
    expect(espia.mock.calls.length).toBeGreaterThan(1);
  });

  describe("retomar un trabajo pausado", () => {
    it("cuota agotada deja el trabajo 'paused' con lo resuelto guardado, y lo retoma sin re-consultarlo", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date("2026-08-15T23:00:00.000Z"));
        const rows = [row("job_1", "r1", 1), row("job_1", "r2", 2), row("job_1", "r3", 3)];
        const store = await conTrabajo(rows);

        // La primera fila se resuelve; de ahí en más, cuota agotada.
        const primera = fakeClient((q, i) => (i === 0 ? hit(q) : Promise.reject(new Error("quota_exhausted"))));
        const salida1 = await processNextJob({ store, client: primera.client, concurrency: 1 });

        expect(salida1.job?.status).toBe("paused");
        expect(salida1.job?.error).toContain("cuota diaria");
        expect(salida1.job?.leaseUntil).toBe("2026-08-16T00:00:00.000Z"); // próxima medianoche UTC
        const trasPausa = await store.listRows("cliente_a", "job_1");
        expect(trasPausa.rows.filter((r) => r.status === "ok")).toHaveLength(1);
        expect(trasPausa.rows.filter((r) => r.status === "pending")).toHaveLength(2);

        // Antes de que se cumpla `leaseUntil`, nadie más puede reclamarlo.
        const segunda = fakeClient((q) => hit(q));
        expect((await processNextJob({ store, client: segunda.client })).claimed).toBe(false);

        // Pasada la medianoche, se retoma solo.
        vi.setSystemTime(new Date("2026-08-16T00:00:01.000Z"));
        const salida2 = await processNextJob({ store, client: segunda.client });

        expect(salida2.claimed).toBe(true);
        expect(salida2.job?.status).toBe("done");
        // Las 2 que faltaban, no las 3 — la ya resuelta no se volvió a pedir.
        expect(segunda.calls).toHaveLength(2);
        expect(salida2.job?.summary).toMatchObject({ total: 3, ok: 3 });
        // 2 de la primera pasada (la que sirvió + el intento que chocó con
        // la cuota, que igual cuenta como consulta) + 2 de esta.
        expect(salida2.job?.queries).toBe(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("credencial rechazada deja el trabajo 'failed', no 'paused'", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows);
    const { client } = fakeClient(() => Promise.reject(new Error("provider_auth_error")));

    const outcome = await processNextJob({ store, client });

    expect(outcome.job?.status).toBe("failed");
    expect(outcome.job?.error).toContain("credencial");
    expect(outcome.job?.leaseUntil).toBeUndefined();
  });

  it("el proveedor caído deja el trabajo 'paused' con reintento corto", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(AHORA));
      const rows = Array.from({ length: 6 }, (_, i) => row("job_1", `r${i + 1}`, i + 1));
      const store = await conTrabajo(rows);
      const { client } = fakeClient(() => Promise.reject(new Error("502 del proveedor")));

      const outcome = await processNextJob({ store, client, concurrency: 1, retries: 0 });

      expect(outcome.job?.status).toBe("paused");
      expect(outcome.job?.error).toContain("no está respondiendo");
      expect(outcome.job?.leaseUntil).toBe(new Date(Date.parse(AHORA) + 10 * 60_000).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("si otro worker se queda con el arriendo, este no escribe nada más", async () => {
    vi.useFakeTimers();
    try {
      const rows = [row("job_1", "r1", 1), row("job_1", "r2", 2)];
      const store = await conTrabajo(rows);

      /*
       * El geocode nunca resuelve solo: cada llamada espera a que el reloj
       * avance, así que el heartbeat alcanza a dispararse en el medio. Y,
       * como haría un proveedor real detrás de `fetch`, respeta `signal`
       * — sin esto la llamada en vuelo nunca se destraba al abortar y el
       * test queda esperando los 50 s completos.
       */
      const client: GeoClient = {
        autocomplete: async () => [],
        reverse: async () => null,
        geocode: (query, _bias, opts) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(hit(query)), 50_000);
            opts?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          }),
      };

      // Cualquier worker que pregunte después del primero se entera de
      // que ya no es dueño.
      store.heartbeat = async () => false;

      const corriendo = processNextJob({ store, client, concurrency: 2, heartbeatIntervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await corriendo;

      expect(outcome.preempted).toBe(true);
      // El trabajo se queda como lo dejó `claimNextJob`: "running", sin
      // pasar a "done" ni "paused" — este worker no lo tocó más.
      const stored = await store.getJob("cliente_a", "job_1");
      expect(stored?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runWorkerLoop", () => {
  it("procesa lo que hay y se detiene al abortar en la espera ociosa", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows);
    const { client } = fakeClient((q) => hit(q));
    const controller = new AbortController();
    const procesados: boolean[] = [];

    const loop = runWorkerLoop({
      store,
      client,
      signal: controller.signal,
      idlePollMs: 10,
      onJobProcessed: (o) => procesados.push(o.claimed),
    });

    // Se procesa el único trabajo y luego queda esperando ocioso.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await loop;

    expect(procesados[0]).toBe(true);
    expect(procesados.some((c) => c === false)).toBe(true);
  });
});

describe("webhooks al terminar un trabajo", () => {
  const WEBHOOKS = { secret: "un-secreto", retryDelayMs: 1 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("avisa 'batch.done' cuando el trabajo termina bien", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows, { webhookUrl: "https://cliente.cl/webhook" });
    const { client } = fakeClient((q) => hit(q));

    let recibido: { headers: Headers; body: any } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        recibido = { headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
        return new Response(null, { status: 200 });
      }),
    );

    const outcome = await processNextJob({ store, client, webhooks: WEBHOOKS });

    expect(outcome.webhookDelivery).toMatchObject({ delivered: true });
    expect(recibido!.headers.get("X-AllRide-Event")).toBe("batch.done");
    expect(recibido!.body).toMatchObject({ type: "batch.done", tenantId: "cliente_a", job: { status: "done" } });
    // Nunca el bookkeeping interno del worker en el cuerpo del webhook.
    expect(recibido!.body.job.workerId).toBeUndefined();
  });

  it("avisa 'batch.paused' cuando se detiene por cuota, no 'batch.done'", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows, { webhookUrl: "https://cliente.cl/webhook" });
    const { client } = fakeClient(() => Promise.reject(new Error("quota_exhausted")));

    let tipoRecibido: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        tipoRecibido = new Headers(init.headers).get("X-AllRide-Event");
        return new Response(null, { status: 200 });
      }),
    );

    await processNextJob({ store, client, webhooks: WEBHOOKS });
    expect(tipoRecibido).toBe("batch.paused");
  });

  it("sin `webhooks` configurado, no se llama a fetch", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows, { webhookUrl: "https://cliente.cl/webhook" });
    const { client } = fakeClient((q) => hit(q));
    const fetchEspiado = vi.fn();
    vi.stubGlobal("fetch", fetchEspiado);

    const outcome = await processNextJob({ store, client });
    expect(outcome.webhookDelivery).toBeUndefined();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });

  it("con `webhooks` configurado pero sin `webhookUrl` en el trabajo, tampoco se llama", async () => {
    const rows = [row("job_1", "r1", 1)];
    const store = await conTrabajo(rows); // sin webhookUrl
    const { client } = fakeClient((q) => hit(q));
    const fetchEspiado = vi.fn();
    vi.stubGlobal("fetch", fetchEspiado);

    const outcome = await processNextJob({ store, client, webhooks: WEBHOOKS });
    expect(outcome.webhookDelivery).toBeUndefined();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });
});
