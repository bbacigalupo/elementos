import { describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { generateApiKey, hashApiKey } from "./keys.ts";
import { createBatchApiHandlers, type BatchApiHandlers, type SyncOptions } from "./handlers.ts";
import { processNextJob } from "./worker.ts";
import { verifyCorrectionToken, type CorrectionLinkConfig } from "./correction-links.ts";
import type { ApiScope } from "./types.ts";
import type { GeoClient, GeocodeOutcome } from "@allride/geo-core";

const AHORA = "2026-08-15T12:00:00.000Z";
const BASE = "https://api.ejemplo.cl/v1/batches";

function hit(query: string): GeocodeOutcome {
  // El número tiene que salir de la consulta real: fijarlo aparte rompe el
  // chequeo de `number_mismatch` para cualquier dirección que no termine en
  // ese mismo número.
  const number = query.match(/\d+/)?.[0] ?? null;
  return {
    matchedLevel: "address",
    value: {
      lat: -33.44, lng: -70.65, formatted: query,
      components: { street: query, number, sublocality: null, commune: null, city: null, region: null, postalCode: null, country: "CL" },
      precision: "rooftop", source: "search", provider: "falso", capturedAt: AHORA,
    },
  };
}

function fakeClient(handler: (query: string, i: number) => GeocodeOutcome | null | Promise<GeocodeOutcome | null>) {
  const calls: string[] = [];
  const client: GeoClient = {
    autocomplete: async () => [],
    reverse: async () => null,
    async geocode(query, _bias, opts) {
      const i = calls.length;
      calls.push(query);
      return new Promise((resolve, reject) => {
        Promise.resolve(handler(query, i)).then(resolve, reject);
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    },
  };
  return { client, calls };
}

async function conCliente(over: {
  scopes?: ApiScope[];
  dailyQuota?: number | null;
  maxRowsPerJob?: number;
  sync?: SyncOptions;
  correctionLinks?: CorrectionLinkConfig;
} = {}): Promise<{ store: MemoryStore; handlers: BatchApiHandlers; key: string }> {
  const store = createMemoryStore();
  const key = generateApiKey();
  store.addApiKey({
    id: "key_1",
    tenantId: "cliente_a",
    keyHash: await hashApiKey(key),
    name: "ERP de nóminas",
    scopes: over.scopes ?? ["batches:write", "batches:read"],
    dailyQuota: "dailyQuota" in over ? over.dailyQuota! : null,
    createdAt: AHORA,
  });
  const handlers = createBatchApiHandlers({
    store,
    maxRowsPerJob: over.maxRowsPerJob ?? 2000,
    sync: over.sync,
    correctionLinks: over.correctionLinks,
  });
  return { store, handlers, key };
}

function post(body: unknown, key: string): Request {
  return new Request(BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(path: string, key?: string): Request {
  return new Request(`${BASE}${path}`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
}

const ADDRESSES_BODY = {
  addresses: ["Av. Providencia 1234, Providencia", "Av. Grecia 3000, Ñuñoa"],
  bias: { country: "CL" },
};

describe("POST — crear trabajo", () => {
  it("crea un trabajo con direcciones en texto libre", async () => {
    const { handlers, key } = await conCliente();
    const res = await handlers.createBatch(post(ADDRESSES_BODY, key));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.status).toBe("pending");
    expect(body.job.rowCount).toBe(2);
    expect(body.job.id).toMatch(/^job_/);
    // Nada de bookkeeping interno del worker en la respuesta pública.
    expect(body.job.workerId).toBeUndefined();
    expect(body.job.leaseUntil).toBeUndefined();
  });

  it("crea un trabajo con tabla (encabezados + filas)", async () => {
    const { handlers, key } = await conCliente();
    const res = await handlers.createBatch(
      post(
        {
          table: {
            headers: ["Nombre", "Dirección"],
            rows: [["Ana", "Av. Providencia 1234, Providencia"], ["Luis", "Av. Grecia 3000, Ñuñoa"]],
          },
          bias: { country: "CL" },
        },
        key,
      ),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.job.rowCount).toBe(2);
    expect(body.job.sourceHeaders).toEqual(["Nombre", "Dirección"]);
  });

  it("rechaza sin bias.country", async () => {
    const { handlers, key } = await conCliente();
    const res = await handlers.createBatch(post({ addresses: ["Av. Providencia 1234"] }, key));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("rechaza sin addresses ni table", async () => {
    const { handlers, key } = await conCliente();
    const res = await handlers.createBatch(post({ bias: { country: "CL" } }, key));
    expect(res.status).toBe(400);
  });

  it("rechaza un body que no es JSON válido", async () => {
    const { handlers, key } = await conCliente();
    const req = new Request(BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: "esto no es json",
    });
    const res = await handlers.createBatch(req);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("bad_request");
  });

  it("rechaza el trabajo entero si supera el tope de filas, sin crear nada", async () => {
    const { handlers, store, key } = await conCliente({ maxRowsPerJob: 2 });
    const res = await handlers.createBatch(
      post({ addresses: ["Calle 1 100", "Calle 2 200", "Calle 3 300"], bias: { country: "CL" } }, key),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("too_many_rows");
    expect(body.limit).toBe(2);
    expect(await store.listJobs("cliente_a")).toHaveLength(0);
  });

  it("requiere el scope batches:write", async () => {
    const { handlers, key } = await conCliente({ scopes: ["batches:read"] });
    const res = await handlers.createBatch(post(ADDRESSES_BODY, key));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });

  describe("idempotencia", () => {
    it("repetir la misma idempotencyKey devuelve el trabajo existente, sin crear otro", async () => {
      const { handlers, store, key } = await conCliente();
      const cuerpo = { ...ADDRESSES_BODY, idempotencyKey: "nomina-agosto" };

      const primera = await handlers.createBatch(post(cuerpo, key));
      expect(primera.status).toBe(201);
      const idPrimera = (await primera.json()).job.id;

      const segunda = await handlers.createBatch(post(cuerpo, key));
      expect(segunda.status).toBe(200);
      expect((await segunda.json()).job.id).toBe(idPrimera);

      expect(await store.listJobs("cliente_a")).toHaveLength(1);
    });

    it("una idempotencyKey distinta sí crea un trabajo nuevo", async () => {
      const { handlers, store, key } = await conCliente();
      await handlers.createBatch(post({ ...ADDRESSES_BODY, idempotencyKey: "a" }, key));
      await handlers.createBatch(post({ ...ADDRESSES_BODY, idempotencyKey: "b" }, key));
      expect(await store.listJobs("cliente_a")).toHaveLength(2);
    });
  });

  describe("cuota del cliente", () => {
    it("rechaza cuando el trabajo pide más de lo que queda hoy", async () => {
      const { handlers, store, key } = await conCliente({ dailyQuota: 1 });
      await store.recordUsage("cliente_a", 1, new Date());
      const res = await handlers.createBatch(post(ADDRESSES_BODY, key)); // pide 2 consultas
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error).toBe("tenant_quota_exceeded");
      expect(body).toMatchObject({ needed: 2, remaining: 0, limit: 1 });
      expect(typeof body.resetsAt).toBe("string");
      expect(await store.listJobs("cliente_a")).toHaveLength(0);
    });

    it("sin tope configurado, ningún volumen se rechaza por cuota", async () => {
      const { handlers, key } = await conCliente({ dailyQuota: null });
      const res = await handlers.createBatch(post(ADDRESSES_BODY, key));
      expect(res.status).toBe(201);
    });
  });
});

describe("GET/DELETE — aislamiento entre clientes", () => {
  async function conDosClientesYUnTrabajo() {
    const store = createMemoryStore();
    const handlers = createBatchApiHandlers({ store });
    const claveA = generateApiKey();
    const claveB = generateApiKey();
    store.addApiKey({
      id: "key_a", tenantId: "cliente_a", keyHash: await hashApiKey(claveA),
      name: "A", scopes: ["batches:write", "batches:read"], dailyQuota: null, createdAt: AHORA,
    });
    store.addApiKey({
      id: "key_b", tenantId: "cliente_b", keyHash: await hashApiKey(claveB),
      name: "B", scopes: ["batches:write", "batches:read"], dailyQuota: null, createdAt: AHORA,
    });
    const creado = await handlers.createBatch(post(ADDRESSES_BODY, claveA));
    const jobId = (await creado.json()).job.id as string;
    return { store, handlers, claveA, claveB, jobId };
  }

  it("el dueño ve su trabajo; el otro cliente no", async () => {
    const { handlers, claveA, claveB, jobId } = await conDosClientesYUnTrabajo();
    expect((await handlers.getBatch(get(`/${jobId}`, claveA), jobId)).status).toBe(200);
    expect((await handlers.getBatch(get(`/${jobId}`, claveB), jobId)).status).toBe(404);
  });

  it("listar solo trae los trabajos propios", async () => {
    const { handlers, claveA, claveB } = await conDosClientesYUnTrabajo();
    const listaA = await (await handlers.listBatches(get("", claveA))).json();
    const listaB = await (await handlers.listBatches(get("", claveB))).json();
    expect(listaA.jobs).toHaveLength(1);
    expect(listaB.jobs).toHaveLength(0);
  });

  it("las filas de un trabajo ajeno dan 404, no una lista vacía", async () => {
    const { handlers, claveB, jobId } = await conDosClientesYUnTrabajo();
    const res = await handlers.listBatchRows(get(`/${jobId}/rows`, claveB), jobId);
    expect(res.status).toBe(404);
  });

  it("las filas del propio trabajo se listan con su total", async () => {
    const { handlers, claveA, jobId } = await conDosClientesYUnTrabajo();
    const res = await handlers.listBatchRows(get(`/${jobId}/rows`, claveA), jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].status).toBe("pending");
  });

  it("un cliente no puede borrar el trabajo de otro, y el dueño sí", async () => {
    const { handlers, store, claveA, claveB, jobId } = await conDosClientesYUnTrabajo();
    expect((await handlers.deleteBatch(get(`/${jobId}`, claveB), jobId)).status).toBe(404);
    expect(await store.getJob("cliente_a", jobId)).not.toBeNull();

    const borrado = await handlers.deleteBatch(get(`/${jobId}`, claveA), jobId);
    expect(borrado.status).toBe(200);
    expect(await store.getJob("cliente_a", jobId)).toBeNull();
  });

  it("un id que nunca existió da 404, no 500", async () => {
    const { handlers, claveA } = await conDosClientesYUnTrabajo();
    const res = await handlers.getBatch(get("/job_no_existe", claveA), "job_no_existe");
    expect(res.status).toBe(404);
  });
});

describe("handle — router", () => {
  it("enruta POST y GET de la base al mismo verbo correcto", async () => {
    const { handlers, key } = await conCliente();
    const creado = await handlers.handle(post(ADDRESSES_BODY, key));
    expect(creado.status).toBe(201);

    const listado = await handlers.handle(get("", key));
    expect(listado.status).toBe(200);
    expect((await listado.json()).jobs).toHaveLength(1);
  });

  it("enruta /:id y /:id/rows", async () => {
    const { handlers, key } = await conCliente();
    const jobId = (await (await handlers.handle(post(ADDRESSES_BODY, key))).json()).job.id;

    expect((await handlers.handle(get(`/${jobId}`, key))).status).toBe(200);
    expect((await handlers.handle(get(`/${jobId}/rows`, key))).status).toBe(200);
  });

  it("un método no soportado en una ruta válida da 405", async () => {
    const { handlers, key } = await conCliente();
    const jobId = (await (await handlers.handle(post(ADDRESSES_BODY, key))).json()).job.id;
    const res = await handlers.handle(
      new Request(`${BASE}/${jobId}/rows`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(405);
  });

  it("una ruta fuera del basePath da 404", async () => {
    const { handlers, key } = await conCliente();
    const res = await handlers.handle(
      new Request("https://api.ejemplo.cl/v1/otra-cosa", { headers: { authorization: `Bearer ${key}` } }),
    );
    expect(res.status).toBe(404);
  });

  it("sin clave, ninguna ruta responde antes de autenticar", async () => {
    const { handlers } = await conCliente();
    const res = await handlers.handle(new Request(BASE));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_api_key");
  });
});

describe("POST — atajo síncrono", () => {
  const ADDRESSES_SYNC = { addresses: ["Av. Providencia 1234", "Av. Grecia 3000"], bias: { country: "CL" }, sync: true };

  it("sin `sync` configurado en el handler, se rechaza sin crear nada", async () => {
    const { handlers, store, key } = await conCliente();
    const res = await handlers.createBatch(post(ADDRESSES_SYNC, key));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("sync_not_configured");
    expect(await store.listJobs("cliente_a")).toHaveLength(0);
  });

  it("procesa el lote en la misma petición y devuelve las filas resueltas", async () => {
    const { client, calls } = fakeClient((q) => hit(q));
    const { handlers, store, key } = await conCliente({ sync: { client } });

    const res = await handlers.createBatch(post(ADDRESSES_SYNC, key));

    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    const body = await res.json();
    expect(body.job.status).toBe("done");
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r: { status: string }) => r.status === "ok")).toBe(true);
    // No queda como "running" colgado para siempre: quien mire el trabajo
    // después ve el mismo estado ya resuelto.
    expect((await store.getJob("cliente_a", body.job.id))?.status).toBe("done");
  });

  it("registra el consumo, igual que el worker asíncrono", async () => {
    const { client } = fakeClient((q) => hit(q));
    const { handlers, store, key } = await conCliente({ sync: { client } });
    await handlers.createBatch(post(ADDRESSES_SYNC, key));
    expect(await store.usageSince("cliente_a", new Date("2026-08-14T00:00:00.000Z"))).toBe(2);
  });

  it("un lote más grande que el tope síncrono se rechaza entero, sin crear el trabajo", async () => {
    const { client, calls } = fakeClient((q) => hit(q));
    const { handlers, store, key } = await conCliente({ sync: { client, maxRows: 1 } });

    const res = await handlers.createBatch(post(ADDRESSES_SYNC, key));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("too_many_rows_for_sync");
    expect(calls).toHaveLength(0);
    expect(await store.listJobs("cliente_a")).toHaveLength(0);
  });

  it("un trabajo detenido por cuota propia igual devuelve lo alcanzado, en 'paused'", async () => {
    const { client } = fakeClient((q, i) => (i === 0 ? hit(q) : Promise.reject(new Error("quota_exhausted"))));
    const { handlers, key } = await conCliente({ sync: { client, concurrency: 1 } });

    const res = await handlers.createBatch(post(ADDRESSES_SYNC, key));
    const body = await res.json();

    expect(body.job.status).toBe("paused");
    expect(body.rows.filter((r: { status: string }) => r.status === "ok")).toHaveLength(1);
    expect(body.rows.filter((r: { status: string }) => r.status === "pending")).toHaveLength(1);
  });

  it("agotado el tiempo de espera, el trabajo vuelve a 'pending' con lo alcanzado guardado", async () => {
    vi.useFakeTimers();
    try {
      const { client, calls } = fakeClient(
        (q) => new Promise((resolve) => setTimeout(() => resolve(hit(q)), 50_000)),
      );
      const { handlers, store, key } = await conCliente({ sync: { client, timeoutMs: 1_000, concurrency: 2 } });

      const corriendo = handlers.createBatch(post(ADDRESSES_SYNC, key));
      /*
       * `createBatch` tiene varios `await` reales (leer el body, crear el
       * trabajo en el store) antes de inscribir el `setTimeout` del límite
       * de espera. Adelantar el reloj de una sola vez, antes de que ese
       * temporizador exista, no lo alcanza a disparar — hay que dejar que
       * la cadena de microtareas llegue hasta ahí primero, sin mover el
       * reloj (avances de 0 ms igual vacían la cola de microtareas).
       */
      for (let i = 0; i < 20 && calls.length === 0; i += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      await vi.advanceTimersByTimeAsync(1_500);
      const res = await corriendo;

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.job.status).toBe("pending");
      expect(calls).toHaveLength(2); // se alcanzaron a pedir, solo que no a tiempo

      const stored = await store.getJob("cliente_a", body.job.id);
      expect(stored?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  describe("idempotencia con sync", () => {
    it("repetir la misma clave devuelve el mismo trabajo con sus filas, sin volver a consultar", async () => {
      const { client, calls } = fakeClient((q) => hit(q));
      const { handlers, key } = await conCliente({ sync: { client } });
      const cuerpo = { ...ADDRESSES_SYNC, idempotencyKey: "nomina-chica" };

      const primera = await handlers.createBatch(post(cuerpo, key));
      expect(primera.status).toBe(201);
      const idPrimera = (await primera.json()).job.id;

      const segunda = await handlers.createBatch(post(cuerpo, key));
      expect(segunda.status).toBe(200);
      const bodySegunda = await segunda.json();
      expect(bodySegunda.job.id).toBe(idPrimera);
      expect(bodySegunda.rows).toHaveLength(2);
      expect(calls).toHaveLength(2); // no se repitieron
    });
  });

  it("un worker que pregunta justo después no encuentra nada que reclamar del trabajo síncrono", async () => {
    const { client } = fakeClient((q) => hit(q));
    const { handlers, store, key } = await conCliente({ sync: { client } });
    await handlers.createBatch(post(ADDRESSES_SYNC, key));

    const otroClient = fakeClient((q) => hit(q)).client;
    const outcome = await processNextJob({ store, client: otroClient });
    expect(outcome.claimed).toBe(false);
  });
});

describe("POST — link de corrección", () => {
  const CORRECTION_CONFIG: CorrectionLinkConfig = {
    secret: "un-secreto-de-prueba-largo",
    baseUrl: "https://miapp.cl/corregir",
  };

  async function conTrabajoYFila(over: { correctionLinks?: CorrectionLinkConfig } = {}) {
    const { handlers, store, key } = await conCliente({
      scopes: ["batches:write", "batches:read", "corrections:write"],
      correctionLinks: over.correctionLinks ?? CORRECTION_CONFIG,
    });
    const creado = await handlers.createBatch(post(ADDRESSES_BODY, key));
    const jobId = (await creado.json()).job.id as string;
    const filas = await (await handlers.listBatchRows(get(`/${jobId}/rows`, key), jobId)).json();
    const rowId = filas.rows[0].row.id as string;
    return { handlers, store, key, jobId, rowId };
  }

  it("sin `correctionLinks` configurado, se rechaza", async () => {
    const { handlers, key } = await conCliente({ scopes: ["batches:write", "batches:read", "corrections:write"] });
    const creado = await handlers.createBatch(post(ADDRESSES_BODY, key));
    const jobId = (await creado.json()).job.id as string;
    const res = await handlers.mintCorrectionLink(get(`/${jobId}/rows/r1/correction-link`, key), jobId, "r1");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("correction_links_not_configured");
  });

  it("emite un link que verifica con los mismos identificadores", async () => {
    const { handlers, key, jobId, rowId } = await conTrabajoYFila();
    const res = await handlers.mintCorrectionLink(get(`/${jobId}/rows/${rowId}/correction-link`, key), jobId, rowId);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.url).toContain(CORRECTION_CONFIG.baseUrl);
    expect(body.url).toContain(body.token);
    expect(typeof body.expiresAt).toBe("string");

    const verificado = await verifyCorrectionToken(CORRECTION_CONFIG, body.token);
    expect(verificado).toMatchObject({ ok: true, payload: { tenantId: "cliente_a", jobId, rowId } });
  });

  it("una fila que no existe da 404, no un link", async () => {
    const { handlers, key, jobId } = await conTrabajoYFila();
    const res = await handlers.mintCorrectionLink(get(`/${jobId}/rows/no-existe/correction-link`, key), jobId, "no-existe");
    expect(res.status).toBe(404);
  });

  it("no se puede emitir un link para la fila de otro cliente", async () => {
    const { jobId, rowId } = await conTrabajoYFila();
    // Otro cliente, mismo despliegue.
    const { handlers: handlersB, key: claveB } = await conCliente({
      scopes: ["batches:write", "batches:read", "corrections:write"],
      correctionLinks: CORRECTION_CONFIG,
    });
    const res = await handlersB.mintCorrectionLink(
      get(`/${jobId}/rows/${rowId}/correction-link`, claveB),
      jobId,
      rowId,
    );
    expect(res.status).toBe(404);
  });

  it("requiere el scope corrections:write, no alcanza con batches:write", async () => {
    const { handlers, key } = await conCliente({
      scopes: ["batches:write", "batches:read"],
      correctionLinks: CORRECTION_CONFIG,
    });
    const creado = await handlers.createBatch(post(ADDRESSES_BODY, key));
    const jobId = (await creado.json()).job.id as string;
    const res = await handlers.mintCorrectionLink(get(`/${jobId}/rows/r1/correction-link`, key), jobId, "r1");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("insufficient_scope");
  });

  it("se enruta bien desde `handle`", async () => {
    const { handlers, key, jobId, rowId } = await conTrabajoYFila();
    const req = new Request(`${BASE}/${jobId}/rows/${rowId}/correction-link`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
    });
    expect((await handlers.handle(req)).status).toBe(201);
  });
});
