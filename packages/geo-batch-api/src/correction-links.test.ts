import { describe, expect, it, vi } from "vitest";
import { createCorrectionLink, verifyCorrectionToken } from "./correction-links.ts";

const CONFIG = { secret: "un-secreto-de-verdad-largo-y-al-azar", baseUrl: "https://miapp.cl/corregir" };
const PARAMS = { tenantId: "cliente_a", jobId: "job_1", rowId: "r1" };

describe("createCorrectionLink", () => {
  it("arma una URL con el token como parámetro", async () => {
    const link = await createCorrectionLink(CONFIG, PARAMS);
    const url = new URL(link.url);
    expect(url.origin + url.pathname).toBe("https://miapp.cl/corregir");
    expect(url.searchParams.get("token")).toBe(link.token);
  });

  it("respeta parámetros que ya traía la URL base", async () => {
    const link = await createCorrectionLink({ ...CONFIG, baseUrl: "https://miapp.cl/corregir?lang=es" }, PARAMS);
    const url = new URL(link.url);
    expect(url.searchParams.get("lang")).toBe("es");
    expect(url.searchParams.get("token")).toBe(link.token);
  });

  it("el vencimiento por defecto es 7 días adelante", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00.000Z"));
    try {
      const link = await createCorrectionLink(CONFIG, PARAMS);
      expect(link.expiresAt).toBe("2026-08-23T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("verifyCorrectionToken", () => {
  it("un token recién emitido verifica y devuelve los mismos datos", async () => {
    const link = await createCorrectionLink(CONFIG, PARAMS);
    const result = await verifyCorrectionToken(CONFIG, link.token);
    expect(result).toMatchObject({ ok: true, payload: PARAMS });
  });

  it("rechaza un token con forma rota", async () => {
    expect(await verifyCorrectionToken(CONFIG, "esto-no-es-un-token")).toMatchObject({
      ok: false, error: "malformed",
    });
    expect(await verifyCorrectionToken(CONFIG, "a.b.c")).toMatchObject({ ok: false, error: "malformed" });
    expect(await verifyCorrectionToken(CONFIG, "***.***")).toMatchObject({ ok: false, error: "malformed" });
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const link = await createCorrectionLink(CONFIG, PARAMS);
    const result = await verifyCorrectionToken({ secret: "otro-secreto" }, link.token);
    expect(result).toMatchObject({ ok: false, error: "invalid_signature" });
  });

  it("rechaza un token adulterado (payload cambiado, firma original)", async () => {
    const link = await createCorrectionLink(CONFIG, PARAMS);
    const [, firma] = link.token.split(".");
    const otroPayload = Buffer.from(JSON.stringify({ ...PARAMS, tenantId: "cliente_b", exp: Date.now() + 999_999 }))
      .toString("base64url");
    const adulterado = `${otroPayload}.${firma}`;
    expect(await verifyCorrectionToken(CONFIG, adulterado)).toMatchObject({ ok: false, error: "invalid_signature" });
  });

  it("rechaza un token vencido, aunque la firma sea correcta", async () => {
    const link = await createCorrectionLink({ ...CONFIG, ttlMs: 1_000 }, PARAMS);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 2_000));
    try {
      expect(await verifyCorrectionToken(CONFIG, link.token)).toMatchObject({ ok: false, error: "expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("dos filas del mismo trabajo emiten tokens distintos y no son intercambiables", async () => {
    const linkA = await createCorrectionLink(CONFIG, { ...PARAMS, rowId: "r1" });
    const linkB = await createCorrectionLink(CONFIG, { ...PARAMS, rowId: "r2" });
    expect(linkA.token).not.toBe(linkB.token);

    const verifA = await verifyCorrectionToken(CONFIG, linkA.token);
    expect(verifA.ok && verifA.payload.rowId).toBe("r1");
  });
});
