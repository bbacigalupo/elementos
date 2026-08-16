import { describe, expect, it, vi } from "vitest";
import { createBatchRateLimit, createDailyQuota, createGeoHandlers, createMemoryRateLimit } from "./handlers.ts";
import { ProviderAuthError, ProviderRateLimitError } from "../fetch-retry.ts";
import type { GeoProvider } from "../providers/types.ts";

function req(ip = "1.2.3.4"): Request {
  return new Request("https://ejemplo.cl/api/geo/geocode?q=x&country=CL", {
    headers: { "x-forwarded-for": ip },
  });
}

describe("createMemoryRateLimit", () => {
  it("corta un lote apenas pasa el tope de la ventana", () => {
    const limit = createMemoryRateLimit(120, 60);
    const aceptadas = Array.from({ length: 500 }, () => limit(req())).filter(Boolean).length;
    // Este es exactamente el problema que motiva el limitador de balde.
    expect(aceptadas).toBe(120);
  });
});

describe("createBatchRateLimit", () => {
  it("deja pasar un lote entero de golpe hasta el tamaño del balde", () => {
    const limit = createBatchRateLimit({ ratePerMinute: 120, burst: 300 });
    const aceptadas = Array.from({ length: 300 }, () => limit(req())).filter(Boolean).length;
    expect(aceptadas).toBe(300);
  });

  it("frena cuando se acaban las fichas", () => {
    const limit = createBatchRateLimit({ ratePerMinute: 120, burst: 10 });
    for (let i = 0; i < 10; i += 1) expect(limit(req())).toBe(true);
    expect(limit(req())).toBe(false);
  });

  it("repone fichas con el paso del tiempo", () => {
    vi.useFakeTimers();
    try {
      const limit = createBatchRateLimit({ ratePerMinute: 60, burst: 5 });
      for (let i = 0; i < 5; i += 1) limit(req());
      expect(limit(req())).toBe(false);
      // 60 por minuto = una ficha por segundo.
      vi.advanceTimersByTime(3000);
      expect(limit(req())).toBe(true);
      expect(limit(req())).toBe(true);
      expect(limit(req())).toBe(true);
      expect(limit(req())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("nunca acumula más fichas que el tamaño del balde", () => {
    vi.useFakeTimers();
    try {
      const limit = createBatchRateLimit({ ratePerMinute: 600, burst: 10 });
      limit(req());
      vi.advanceTimersByTime(60 * 60 * 1000);
      const aceptadas = Array.from({ length: 50 }, () => limit(req())).filter(Boolean).length;
      expect(aceptadas).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cuenta por IP, no en total", () => {
    const limit = createBatchRateLimit({ burst: 2 });
    expect(limit(req("1.1.1.1"))).toBe(true);
    expect(limit(req("1.1.1.1"))).toBe(true);
    expect(limit(req("1.1.1.1"))).toBe(false);
    expect(limit(req("2.2.2.2"))).toBe(true);
  });
});

describe("429 del proveedor", () => {
  function providerQueRespondeConLimite(): GeoProvider {
    return {
      name: "falso",
      capabilities: { autocomplete: true, geocode: true, reverse: true },
      autocomplete: async () => [],
      reverse: async () => null,
      geocode: async () => {
        throw new ProviderRateLimitError("Falso", 30);
      },
    };
  }

  it("se responde como 429 rate_limited y no como error genérico", async () => {
    const handlers = createGeoHandlers({
      provider: providerQueRespondeConLimite(),
      rateLimit: false,
    });
    const res = await handlers.geocode(
      new Request("https://ejemplo.cl/api/geo/geocode?q=Av.%20Providencia%201234&country=CL"),
    );

    // Antes devolvía 502 provider_error, y el motor de lote daba la
    // dirección por fallida tras dos reintentos de 300 ms.
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ ok: false, error: "rate_limited", source: "provider" });
  });

  it("propaga el Retry-After que indicó el proveedor", async () => {
    const handlers = createGeoHandlers({
      provider: providerQueRespondeConLimite(),
      rateLimit: false,
    });
    const res = await handlers.geocode(
      new Request("https://ejemplo.cl/api/geo/geocode?q=Av.%20Providencia%201234&country=CL"),
    );
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});

describe("cuota diaria propia", () => {
  function proveedorOk(): GeoProvider {
    return {
      name: "falso",
      capabilities: { autocomplete: true, geocode: true, reverse: true },
      autocomplete: async () => [],
      reverse: async () => null,
      geocode: async () => null,
    };
  }

  it("deja pasar consultas hasta el límite configurado", async () => {
    const handlers = createGeoHandlers({
      provider: proveedorOk(),
      rateLimit: false,
      dailyQuota: createDailyQuota(2),
    });
    const url = "https://ejemplo.cl/api/geo/geocode?q=Av.%20Providencia%201234&country=CL";

    expect((await handlers.geocode(new Request(url))).status).toBe(200);
    expect((await handlers.geocode(new Request(url))).status).toBe(200);
    const tercera = await handlers.geocode(new Request(url));
    expect(tercera.status).toBe(503);
    expect(await tercera.json()).toMatchObject({ ok: false, error: "quota_exhausted" });
  });

  it("no gasta la consulta real al proveedor una vez agotada", async () => {
    let llamadas = 0;
    const provider: GeoProvider = {
      ...proveedorOk(),
      geocode: async () => {
        llamadas += 1;
        return null;
      },
    };
    const handlers = createGeoHandlers({ provider, rateLimit: false, dailyQuota: createDailyQuota(1) });
    const url = "https://ejemplo.cl/api/geo/geocode?q=Av.%20Providencia%201234&country=CL";

    await handlers.geocode(new Request(url));
    await handlers.geocode(new Request(url));
    expect(llamadas).toBe(1);
  });

  it("/quota informa cuánto queda sin gastarlo", async () => {
    const handlers = createGeoHandlers({
      provider: proveedorOk(),
      rateLimit: false,
      dailyQuota: createDailyQuota(5),
    });
    await handlers.geocode(new Request("https://ejemplo.cl/api/geo/geocode?q=x&country=CL"));

    const res = await handlers.quota(new Request("https://ejemplo.cl/api/geo/quota"));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, configured: true, limit: 5, used: 1, remaining: 4 });
    expect(typeof body.resetsAt).toBe("string");
  });

  it("/quota dice que no hay tope cuando no se configuró ninguno", async () => {
    const handlers = createGeoHandlers({ provider: proveedorOk(), rateLimit: false });
    const res = await handlers.quota(new Request("https://ejemplo.cl/api/geo/quota"));
    expect(await res.json()).toEqual({ ok: true, configured: false });
  });

  it("se repone al pasar la medianoche", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-16T23:59:00Z"));
      const quota = createDailyQuota(2);
      quota.use(2);
      expect(quota.hasRemaining()).toBe(false);

      vi.setSystemTime(new Date("2026-08-17T00:00:01Z"));
      expect(quota.hasRemaining()).toBe(true);
      expect(quota.status().used).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("credencial rechazada", () => {
  it("se responde como 500 provider_auth_error, no como error genérico", async () => {
    const provider: GeoProvider = {
      name: "falso",
      capabilities: { autocomplete: true, geocode: true, reverse: true },
      autocomplete: async () => [],
      reverse: async () => null,
      geocode: async () => {
        throw new ProviderAuthError("Falso");
      },
    };
    const handlers = createGeoHandlers({ provider, rateLimit: false });
    const res = await handlers.geocode(
      new Request("https://ejemplo.cl/api/geo/geocode?q=Av.%20Providencia%201234&country=CL"),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: "provider_auth_error" });
  });
});
