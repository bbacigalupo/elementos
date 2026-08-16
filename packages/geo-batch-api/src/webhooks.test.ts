import { afterEach, describe, expect, it, vi } from "vitest";
import { eventTypeForJobStatus, sendWebhook, verifyWebhookSignature, type WebhookEvent } from "./webhooks.ts";
import type { BatchJob } from "./types.ts";

const CONFIG = { secret: "un-secreto-de-prueba", retryDelayMs: 1 };

function job(): Omit<BatchJob, "workerId" | "leaseUntil"> {
  return {
    id: "job_1",
    tenantId: "cliente_a",
    status: "done",
    createdAt: "2026-08-16T12:00:00.000Z",
    expiresAt: "2026-09-15T12:00:00.000Z",
    bias: { country: "CL" },
    sourceHeaders: null,
    rowCount: 1,
    summary: { total: 1, ok: 1, uncertain: 0, failed: 0, corrected: 0, pending: 0 },
    queries: 1,
  };
}

function event(over: Partial<WebhookEvent> = {}): WebhookEvent {
  return { type: "batch.done", createdAt: "2026-08-16T12:00:05.000Z", tenantId: "cliente_a", job: job(), ...over };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendWebhook", () => {
  it("entrega en el primer intento y firma correctamente", async () => {
    let recibido: { headers: Headers; body: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        recibido = { headers: new Headers(init.headers), body: init.body as string };
        return new Response(null, { status: 200 });
      }),
    );

    const resultado = await sendWebhook(CONFIG, "https://cliente.cl/webhook", event());

    expect(resultado).toEqual({ delivered: true, status: 200, attempts: 1 });
    expect(recibido!.headers.get("X-AllRide-Event")).toBe("batch.done");
    const firma = recibido!.headers.get("X-AllRide-Signature");
    expect(await verifyWebhookSignature(CONFIG.secret, recibido!.body, firma)).toBe(true);
  });

  it("reintenta ante un 500 y entrega si el segundo intento funciona", async () => {
    let llamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        llamadas += 1;
        return new Response(null, { status: llamadas === 1 ? 503 : 200 });
      }),
    );

    const resultado = await sendWebhook(CONFIG, "https://cliente.cl/webhook", event());
    expect(resultado).toEqual({ delivered: true, status: 200, attempts: 2 });
  });

  it("no reintenta ante un 4xx — el receptor rechazó la petición, no un tropiezo", async () => {
    let llamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        llamadas += 1;
        return new Response(null, { status: 400 });
      }),
    );

    const resultado = await sendWebhook(CONFIG, "https://cliente.cl/webhook", event());
    expect(resultado).toMatchObject({ delivered: false, status: 400, attempts: 1 });
    expect(llamadas).toBe(1);
  });

  it("se rinde tras agotar los reintentos ante un 5xx persistente", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    const resultado = await sendWebhook({ ...CONFIG, retries: 2 }, "https://cliente.cl/webhook", event());
    expect(resultado).toMatchObject({ delivered: false, attempts: 3 }); // 1 + 2 reintentos
  });

  it("reintenta ante una falla de red, no solo ante una respuesta mala", async () => {
    let llamadas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        llamadas += 1;
        if (llamadas === 1) throw new Error("network error simulado");
        return new Response(null, { status: 200 });
      }),
    );

    const resultado = await sendWebhook(CONFIG, "https://cliente.cl/webhook", event());
    expect(resultado).toEqual({ delivered: true, status: 200, attempts: 2 });
  });

  it("nunca lanza, ni siquiera tras agotar los reintentos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("siempre falla"); }));
    await expect(sendWebhook({ ...CONFIG, retries: 1 }, "https://cliente.cl/webhook", event())).resolves.toMatchObject({
      delivered: false,
      error: "siempre falla",
    });
  });
});

describe("verifyWebhookSignature", () => {
  it("rechaza un body adulterado después de firmarlo", async () => {
    let firma: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        firma = new Headers(init.headers).get("X-AllRide-Signature");
        return new Response(null, { status: 200 });
      }),
    );
    await sendWebhook(CONFIG, "https://cliente.cl/webhook", event());

    const bodyAdulterado = JSON.stringify(event({ tenantId: "cliente_b" }));
    expect(await verifyWebhookSignature(CONFIG.secret, bodyAdulterado, firma)).toBe(false);
  });

  it("rechaza con el secreto equivocado", async () => {
    const body = JSON.stringify(event());
    const firmadoConOtro = await (async () => {
      let firma: string | null = null;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: RequestInit) => {
          firma = new Headers(init.headers).get("X-AllRide-Signature");
          return new Response(null, { status: 200 });
        }),
      );
      await sendWebhook(CONFIG, "https://cliente.cl/webhook", JSON.parse(body));
      return firma;
    })();
    expect(await verifyWebhookSignature("otro-secreto", body, firmadoConOtro)).toBe(false);
  });

  it("rechaza un header sin la forma esperada", async () => {
    expect(await verifyWebhookSignature(CONFIG.secret, "{}", null)).toBe(false);
    expect(await verifyWebhookSignature(CONFIG.secret, "{}", "no-tiene-el-prefijo")).toBe(false);
  });
});

describe("eventTypeForJobStatus", () => {
  it.each([
    ["done", "batch.done"],
    ["paused", "batch.paused"],
    ["failed", "batch.failed"],
  ] as const)("%s → %s", (estado, esperado) => {
    expect(eventTypeForJobStatus(estado)).toBe(esperado);
  });

  it.each(["pending", "running", "cancelled"] as const)("%s no genera evento", (estado) => {
    expect(eventTypeForJobStatus(estado)).toBeNull();
  });
});
