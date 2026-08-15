import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "./fetch-retry.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockResponses(...responses: Array<Response | Error>) {
  const fn = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("sin respuestas restantes");
    if (next instanceof Error) throw next;
    return next;
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("fetchWithRetry", () => {
  it("reintenta un 503 transitorio y devuelve el éxito", async () => {
    const fn = mockResponses(new Response("", { status: 503 }), new Response("{}", { status: 200 }));
    const res = await fetchWithRetry("https://x.test", {}, { baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("reintenta errores de red", async () => {
    const fn = mockResponses(new TypeError("network"), new Response("{}", { status: 200 }));
    const res = await fetchWithRetry("https://x.test", {}, { baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("no reintenta un 404: repetir no cambia el resultado", async () => {
    const fn = mockResponses(new Response("", { status: 404 }));
    const res = await fetchWithRetry("https://x.test", {}, { baseDelayMs: 1 });
    expect(res.status).toBe(404);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("agota los reintentos y devuelve la última respuesta", async () => {
    const fn = mockResponses(
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
    );
    const res = await fetchWithRetry("https://x.test", {}, { retries: 2, baseDelayMs: 1 });
    expect(res.status).toBe(503);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respeta un Retry-After corto", async () => {
    const fn = mockResponses(
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
      new Response("{}", { status: 200 }),
    );
    const res = await fetchWithRetry("https://x.test", {}, { baseDelayMs: 1 });
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("no insiste si el servidor pide esperar demasiado", async () => {
    const fn = mockResponses(new Response("", { status: 429, headers: { "retry-after": "120" } }));
    const res = await fetchWithRetry("https://x.test", {}, { baseDelayMs: 1 });
    expect(res.status).toBe(429);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("propaga la cancelación sin reintentar", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    await expect(
      fetchWithRetry("https://x.test", { signal: controller.signal }, { signal: controller.signal, baseDelayMs: 1 }),
    ).rejects.toThrow(/abort/i);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
