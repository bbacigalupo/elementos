import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { createCorrectionLink, type CorrectionLinkConfig } from "./correction-links.ts";
import { createCorrectionHandlers, type CorrectionHandlers } from "./correction-handlers.ts";
import type { WebhookConfig } from "./webhooks.ts";
import type { BatchJob, StoredRow } from "./types.ts";
import type { LocationValue } from "@allride/geo-core";

const AHORA = "2026-08-15T12:00:00.000Z";
const BASE = "https://api.ejemplo.cl/v1/corrections";
const CONFIG: CorrectionLinkConfig = { secret: "un-secreto-de-prueba-largo", baseUrl: "https://miapp.cl/corregir" };

function job(over: Partial<BatchJob> = {}): BatchJob {
  return {
    id: "job_1",
    tenantId: "cliente_a",
    status: "done",
    createdAt: AHORA,
    expiresAt: "2026-09-14T12:00:00.000Z",
    bias: { country: "CL" },
    sourceHeaders: null,
    rowCount: 1,
    summary: { total: 1, ok: 0, uncertain: 1, failed: 0, corrected: 0, pending: 0 },
    queries: 1,
    ...over,
  };
}

function row(id: string, over: Partial<StoredRow> = {}): StoredRow {
  return {
    jobId: "job_1",
    updatedAt: AHORA,
    row: { id, index: 1, raw: `Calle ${id} 100`, query: `Calle ${id} 100` },
    status: "uncertain",
    value: null,
    matchedLevel: null,
    issues: [{ code: "no_house_number" }],
    ...over,
  };
}

const NUEVO_PUNTO: LocationValue = {
  lat: -33.44,
  lng: -70.65,
  formatted: "Av. Grecia 3000, Ñuñoa",
  components: {
    street: "Av. Grecia", number: "3000", sublocality: null, commune: "Ñuñoa",
    city: "Santiago", region: "Región Metropolitana de Santiago", postalCode: null, country: "CL",
  },
  precision: "rooftop",
  source: "pin",
  provider: "no debería importar lo que mande el body",
  capturedAt: AHORA,
};

async function conFilaYToken(
  rows: StoredRow[] = [row("r1")],
  jobOver: Partial<BatchJob> = {},
  webhooks?: WebhookConfig,
): Promise<{ store: MemoryStore; handlers: CorrectionHandlers; token: string }> {
  const store = createMemoryStore();
  await store.createJob(job(jobOver), rows);
  const handlers = createCorrectionHandlers({ store, correctionLinks: CONFIG, webhooks });
  const { token } = await createCorrectionLink(CONFIG, { tenantId: "cliente_a", jobId: "job_1", rowId: "r1" });
  return { store, handlers, token };
}

function get(token: string): Request {
  return new Request(`${BASE}/${token}`);
}

function post(token: string, body: unknown): Request {
  return new Request(`${BASE}/${token}`, { method: "POST", body: JSON.stringify(body) });
}

describe("GET — leer la fila por token", () => {
  it("un token válido devuelve la fila", async () => {
    const { handlers, token } = await conFilaYToken();
    const res = await handlers.getRow(get(token), token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row.row.id).toBe("r1");
    expect(body.row.status).toBe("uncertain");
  });

  it("un token con forma rota da 401 malformed_token", async () => {
    const { handlers } = await conFilaYToken();
    const res = await handlers.getRow(get("esto-no-es-un-token"), "esto-no-es-un-token");
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("malformed_token");
  });

  it("un token con la forma correcta pero la firma adulterada da 401 invalid_token", async () => {
    const { handlers, token } = await conFilaYToken();
    // Misma forma (payload real, base64url válido), firma distinta — es
    // justo lo que produciría alguien tratando de fabricar un token sin
    // conocer el secreto.
    const adulterado = `${token.split(".")[0]}.firma-que-no-calza`;
    const res = await handlers.getRow(get(adulterado), adulterado);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_token");
  });

  it("un token vencido da 401 expired_token", async () => {
    const { token } = await createCorrectionLink({ ...CONFIG, ttlMs: -1 }, {
      tenantId: "cliente_a", jobId: "job_1", rowId: "r1",
    });
    const store = createMemoryStore();
    await store.createJob(job(), [row("r1")]);
    const handlers = createCorrectionHandlers({ store, correctionLinks: CONFIG });
    const res = await handlers.getRow(get(token), token);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("expired_token");
  });

  it("un token válido para una fila que ya no existe da 404", async () => {
    const { handlers, store, token } = await conFilaYToken();
    await store.deleteJob("cliente_a", "job_1");
    const res = await handlers.getRow(get(token), token);
    expect(res.status).toBe(404);
  });
});

describe("POST — aplicar la corrección", () => {
  it("corrige la fila: cambia estado, punto y fecha", async () => {
    const { handlers, store, token } = await conFilaYToken();
    const res = await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.row.status).toBe("corrected");
    expect(body.row.value.formatted).toBe(NUEVO_PUNTO.formatted);
    expect(body.row.correctedAt).toBeDefined();
    expect(body.row.issues).toEqual([]);

    const guardada = await store.getRow("cliente_a", "job_1", "r1");
    expect(guardada?.status).toBe("corrected");
  });

  it("el proveedor y el origen los decide el servidor, no lo que mande el body", async () => {
    const { handlers, token } = await conFilaYToken();
    const res = await handlers.submitCorrection(
      post(token, { ...NUEVO_PUNTO, source: "search", provider: "otro-proveedor" }),
      token,
    );
    const body = await res.json();
    expect(body.row.value.source).toBe("pin");
    expect(body.row.value.provider).toBe("corrección manual");
  });

  it("propaga la corrección a toda la familia de filas repetidas", async () => {
    const original = row("r1", { row: { id: "r1", index: 1, raw: "Calle A 100", query: "Calle A 100" } });
    const copia1 = row("r2", {
      row: { id: "r2", index: 2, raw: "Calle A 100", query: "Calle A 100", duplicateOf: "r1" },
      fromDuplicate: true,
    });
    const copia2 = row("r3", {
      row: { id: "r3", index: 3, raw: "Calle A 100", query: "Calle A 100", duplicateOf: "r1" },
      fromDuplicate: true,
    });
    const { handlers, store, token } = await conFilaYToken([original, copia1, copia2], {
      rowCount: 3,
      summary: { total: 3, ok: 0, uncertain: 3, failed: 0, corrected: 0, pending: 0 },
    });

    await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);

    const r2 = await store.getRow("cliente_a", "job_1", "r2");
    const r3 = await store.getRow("cliente_a", "job_1", "r3");
    expect(r2?.status).toBe("corrected");
    expect(r2?.value?.formatted).toBe(NUEVO_PUNTO.formatted);
    expect(r2?.fromDuplicate).toBe(true);
    expect(r3?.status).toBe("corrected");
  });

  it("actualiza el resumen del trabajo", async () => {
    const { handlers, store, token } = await conFilaYToken();
    await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    const trabajo = await store.getJob("cliente_a", "job_1");
    expect(trabajo?.summary).toMatchObject({ total: 1, uncertain: 0, corrected: 1 });
  });

  it("confirmar un punto ya exitoso sin moverlo no cuenta como corrección", async () => {
    const puntoExacto: LocationValue = { ...NUEVO_PUNTO };
    const { handlers, store, token } = await conFilaYToken([
      row("r1", { status: "ok", value: puntoExacto, issues: [] }),
    ]);

    const res = await handlers.submitCorrection(post(token, puntoExacto), token);
    expect(res.status).toBe(200);
    const guardada = await store.getRow("cliente_a", "job_1", "r1");
    expect(guardada?.status).toBe("ok");
    expect(guardada?.correctedAt).toBeUndefined();
  });

  it("mover el pin de una fila exitosa sí cuenta como corrección", async () => {
    const puntoOriginal: LocationValue = { ...NUEVO_PUNTO, lat: -33.0, lng: -70.0 };
    const { handlers, store, token } = await conFilaYToken([
      row("r1", { status: "ok", value: puntoOriginal, issues: [] }),
    ]);
    await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    const guardada = await store.getRow("cliente_a", "job_1", "r1");
    expect(guardada?.status).toBe("corrected");
  });

  it("rechaza un body sin forma de LocationValue", async () => {
    const { handlers, token } = await conFilaYToken();
    const res = await handlers.submitCorrection(post(token, { lat: -33.4 }), token);
    expect(res.status).toBe(400);
  });

  it("rechaza un body que no es JSON válido", async () => {
    const { handlers, token } = await conFilaYToken();
    const req = new Request(`${BASE}/${token}`, { method: "POST", body: "no es json" });
    const res = await handlers.submitCorrection(req, token);
    expect(res.status).toBe(400);
  });

  it("un token inválido no modifica nada", async () => {
    const { handlers, store } = await conFilaYToken();
    const res = await handlers.submitCorrection(post("token-invalido", NUEVO_PUNTO), "token-invalido");
    expect(res.status).toBe(401);
    const fila = await store.getRow("cliente_a", "job_1", "r1");
    expect(fila?.status).toBe("uncertain");
  });
});

describe("handle — router", () => {
  it("enruta GET y POST según el verbo", async () => {
    const { handlers, token } = await conFilaYToken();
    expect((await handlers.handle(get(token))).status).toBe(200);
    expect((await handlers.handle(post(token, NUEVO_PUNTO))).status).toBe(200);
  });

  it("sin token en la ruta, da 404", async () => {
    const { handlers } = await conFilaYToken();
    const res = await handlers.handle(new Request(BASE));
    expect(res.status).toBe(404);
  });

  it("un método no soportado da 405", async () => {
    const { handlers, token } = await conFilaYToken();
    const res = await handlers.handle(new Request(`${BASE}/${token}`, { method: "DELETE" }));
    expect(res.status).toBe(405);
  });
});

describe("webhooks al corregir", () => {
  const WEBHOOKS: WebhookConfig = { secret: "un-secreto", retryDelayMs: 1 };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Fire-and-forget: `submitCorrection` no espera a que el webhook salga. */
  function esperarUnMomento(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("avisa 'batch.row_corrected' con la fila corregida, sin bloquear la respuesta", async () => {
    const { handlers, token } = await conFilaYToken(
      [row("r1")],
      { webhookUrl: "https://cliente.cl/webhook" },
      WEBHOOKS,
    );

    let recibido: { headers: Headers; body: any } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        recibido = { headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
        return new Response(null, { status: 200 });
      }),
    );

    const res = await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    expect(res.status).toBe(200); // respondió sin esperar al webhook

    await esperarUnMomento();
    expect(recibido!.headers.get("X-AllRide-Event")).toBe("batch.row_corrected");
    expect(recibido!.body).toMatchObject({
      type: "batch.row_corrected",
      tenantId: "cliente_a",
      row: { row: { id: "r1" }, status: "corrected" },
    });
  });

  it("confirmar sin mover el pin no dispara webhook — no hubo corrección que avisar", async () => {
    const puntoExacto = NUEVO_PUNTO;
    const { handlers, token } = await conFilaYToken(
      [row("r1", { status: "ok", value: puntoExacto, issues: [] })],
      { webhookUrl: "https://cliente.cl/webhook" },
      WEBHOOKS,
    );
    const fetchEspiado = vi.fn();
    vi.stubGlobal("fetch", fetchEspiado);

    await handlers.submitCorrection(post(token, puntoExacto), token);
    await esperarUnMomento();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });

  it("sin `webhooks` configurado, no se llama a fetch", async () => {
    const { handlers, token } = await conFilaYToken([row("r1")], { webhookUrl: "https://cliente.cl/webhook" });
    const fetchEspiado = vi.fn();
    vi.stubGlobal("fetch", fetchEspiado);

    await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    await esperarUnMomento();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });

  it("con `webhooks` configurado pero sin `webhookUrl` en el trabajo, tampoco se llama", async () => {
    const { handlers, token } = await conFilaYToken([row("r1")], {}, WEBHOOKS);
    const fetchEspiado = vi.fn();
    vi.stubGlobal("fetch", fetchEspiado);

    await handlers.submitCorrection(post(token, NUEVO_PUNTO), token);
    await esperarUnMomento();
    expect(fetchEspiado).not.toHaveBeenCalled();
  });
});
