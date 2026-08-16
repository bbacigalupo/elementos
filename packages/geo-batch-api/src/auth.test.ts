import { describe, expect, it } from "vitest";
import { createMemoryStore, type MemoryStore } from "./memory-store.ts";
import { generateApiKey, hashApiKey } from "./keys.ts";
import { authenticate, quotaStatus } from "./auth.ts";
import type { ApiScope } from "./types.ts";

const AHORA = "2026-08-15T12:00:00.000Z";

async function conClave(
  over: { scopes?: ApiScope[]; dailyQuota?: number | null; revokedAt?: string } = {},
): Promise<{ store: MemoryStore; key: string }> {
  const store = createMemoryStore();
  const key = generateApiKey();
  store.addApiKey({
    id: "key_1",
    tenantId: "cliente_a",
    keyHash: await hashApiKey(key),
    name: "ERP de nóminas",
    scopes: over.scopes ?? ["batches:write", "batches:read"],
    dailyQuota: "dailyQuota" in over ? over.dailyQuota! : 5000,
    createdAt: AHORA,
    revokedAt: over.revokedAt,
  });
  return { store, key };
}

function req(auth?: string): Request {
  return new Request("https://api.ejemplo.cl/v1/batches", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("authenticate", () => {
  it("acepta una clave válida y resuelve el tenant", async () => {
    const { store, key } = await conClave();
    const result = await authenticate(req(`Bearer ${key}`), store);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.context.tenantId).toBe("cliente_a");
  });

  it("rechaza sin encabezado Authorization", async () => {
    const { store } = await conClave();
    const result = await authenticate(req(), store);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_key", status: 401 } });
  });

  it("rechaza un esquema que no sea Bearer", async () => {
    const { store, key } = await conClave();
    const result = await authenticate(req(`Token ${key}`), store);
    expect(result).toMatchObject({ ok: false, error: { code: "missing_key" } });
  });

  it("rechaza algo sin forma de clave nuestra, sin tocar el store", async () => {
    const { store } = await conClave();
    const result = await authenticate(req("Bearer no-es-una-clave"), store);
    expect(result).toMatchObject({ ok: false, error: { code: "malformed_key", status: 401 } });
  });

  it("rechaza una clave con forma correcta pero que no existe", async () => {
    const { store } = await conClave();
    const otra = generateApiKey();
    const result = await authenticate(req(`Bearer ${otra}`), store);
    expect(result).toMatchObject({ ok: false, error: { code: "invalid_key", status: 401 } });
  });

  it("rechaza una clave revocada, incluso siendo válida", async () => {
    const { store, key } = await conClave({ revokedAt: AHORA });
    const result = await authenticate(req(`Bearer ${key}`), store);
    expect(result).toMatchObject({ ok: false, error: { code: "revoked_key", status: 401 } });
  });

  it("rechaza cuando falta el scope pedido", async () => {
    const { store, key } = await conClave({ scopes: ["batches:read"] });
    const result = await authenticate(req(`Bearer ${key}`), store, { scope: "batches:write" });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "insufficient_scope", status: 403, required: "batches:write" },
    });
  });

  it("deja pasar cuando el scope pedido está entre los de la clave", async () => {
    const { store, key } = await conClave({ scopes: ["batches:write", "corrections:write"] });
    const result = await authenticate(req(`Bearer ${key}`), store, { scope: "corrections:write" });
    expect(result.ok).toBe(true);
  });

  it("registra el último uso al autenticar", async () => {
    const { store, key } = await conClave();
    const luego = new Date("2026-08-16T09:00:00.000Z");
    await authenticate(req(`Bearer ${key}`), store, { now: luego });
    const stored = await store.findApiKeyByHash(await hashApiKey(key));
    expect(stored?.lastUsedAt).toBe(luego.toISOString());
  });

  it("dos clientes con claves distintas nunca se cruzan", async () => {
    const store = createMemoryStore();
    const claveA = generateApiKey();
    const claveB = generateApiKey();
    store.addApiKey({
      id: "key_a", tenantId: "cliente_a", keyHash: await hashApiKey(claveA),
      name: "A", scopes: ["batches:write"], dailyQuota: null, createdAt: AHORA,
    });
    store.addApiKey({
      id: "key_b", tenantId: "cliente_b", keyHash: await hashApiKey(claveB),
      name: "B", scopes: ["batches:write"], dailyQuota: null, createdAt: AHORA,
    });

    const a = await authenticate(req(`Bearer ${claveA}`), store);
    const b = await authenticate(req(`Bearer ${claveB}`), store);
    expect(a.ok && a.context.tenantId).toBe("cliente_a");
    expect(b.ok && b.context.tenantId).toBe("cliente_b");
  });
});

describe("quotaStatus", () => {
  it("sin tope configurado, no hay límite que reportar", async () => {
    const { store, key } = await conClave({ dailyQuota: null });
    const auth = await authenticate(req(`Bearer ${key}`), store);
    if (!auth.ok) throw new Error("debía autenticar");
    const status = await quotaStatus(store, auth.context.key, new Date(AHORA));
    expect(status).toEqual({ limit: null, used: 0, remaining: null, resetsAt: null });
  });

  it("cuenta lo consumido desde la medianoche UTC del día actual", async () => {
    const { store, key } = await conClave({ dailyQuota: 100 });
    const auth = await authenticate(req(`Bearer ${key}`), store);
    if (!auth.ok) throw new Error("debía autenticar");

    // Ayer no cuenta para hoy.
    await store.recordUsage("cliente_a", 40, new Date("2026-08-14T23:00:00.000Z"));
    await store.recordUsage("cliente_a", 30, new Date("2026-08-15T05:00:00.000Z"));

    const status = await quotaStatus(store, auth.context.key, new Date("2026-08-15T12:00:00.000Z"));
    expect(status).toEqual({ limit: 100, used: 30, remaining: 70, resetsAt: "2026-08-16T00:00:00.000Z" });
  });

  it("nunca reporta cuota negativa cuando se pasó del tope", async () => {
    const { store, key } = await conClave({ dailyQuota: 10 });
    const auth = await authenticate(req(`Bearer ${key}`), store);
    if (!auth.ok) throw new Error("debía autenticar");
    await store.recordUsage("cliente_a", 25, new Date("2026-08-15T05:00:00.000Z"));

    const status = await quotaStatus(store, auth.context.key, new Date("2026-08-15T12:00:00.000Z"));
    expect(status).toEqual({ limit: 10, used: 25, remaining: 0, resetsAt: "2026-08-16T00:00:00.000Z" });
  });
});
