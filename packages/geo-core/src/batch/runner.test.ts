import { describe, expect, it, vi } from "vitest";
import { estimateBatchMs, runBatch, type BatchProgress } from "./runner.ts";
import { buildRows } from "./parse.ts";
import type { GeoClient } from "../client/index.ts";
import type { GeoBias, GeocodeOutcome } from "../types.ts";

const BIAS: GeoBias = { country: "CL" };

function hit(query: string, lat = -33.44, lng = -70.65): GeocodeOutcome {
  const [street, number] = [query.replace(/\s*\d+.*$/, "").trim(), query.match(/\d+/)?.[0] ?? null];
  return {
    matchedLevel: "address",
    value: {
      lat,
      lng,
      formatted: query,
      components: {
        street, number, sublocality: null, commune: null,
        city: null, region: null, postalCode: null, country: "CL",
      },
      precision: "rooftop",
      source: "search",
      provider: "falso",
      capturedAt: new Date().toISOString(),
    },
  };
}

/** Proveedor de mentira: registra qué se le preguntó y cuándo. */
function fakeClient(
  handler: (query: string, callIndex: number) => GeocodeOutcome | null | Promise<GeocodeOutcome | null>,
) {
  const calls: Array<{ query: string; at: number }> = [];
  const client: GeoClient = {
    autocomplete: async () => [],
    reverse: async () => null,
    async geocode(query) {
      const index = calls.length;
      calls.push({ query, at: Date.now() });
      return handler(query, index);
    },
  };
  return { client, calls };
}

function linesFor(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Calle ${i + 1} 100, Santiago`);
}

describe("runBatch", () => {
  it("geocodifica todas las filas y las clasifica", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(4) });
    const { client, calls } = fakeClient((q) => hit(q));

    const result = await runBatch(rows, { client, bias: BIAS });

    expect(calls).toHaveLength(4);
    expect(result.summary).toMatchObject({ total: 4, ok: 4, failed: 0 });
    expect(result.cancelled).toBe(false);
  });

  it("no consulta dos veces la misma dirección: el duplicado hereda", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: ["Av. Grecia 3000, Ñuñoa", "AV. GRECIA 3000, ÑUÑOA", "Av. Providencia 1234"],
    });
    const { client, calls } = fakeClient((q) => hit(q));

    const result = await runBatch(rows, { client, bias: BIAS });

    expect(calls).toHaveLength(2);
    expect(result.results).toHaveLength(3);
    expect(result.results[1].fromDuplicate).toBe(true);
    expect(result.results[1].value).toEqual(result.results[0].value);
    expect(result.summary.ok).toBe(3);
  });

  it("el progreso llega a 100% contando también los duplicados", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: ["Av. Grecia 3000", "Av. Grecia 3000", "Av. Providencia 1234"],
    });
    const { client } = fakeClient((q) => hit(q));
    const progress: BatchProgress[] = [];

    await runBatch(rows, { client, bias: BIAS, onProgress: (p) => progress.push({ ...p }) });

    const last = progress[progress.length - 1];
    expect(last.total).toBe(3);
    expect(last.done).toBe(3);
    expect(last.queries).toBe(2);
  });

  it("una fila fallida no derrumba el lote", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(3) });
    const { client } = fakeClient((q, i) => {
      if (i === 1) throw new Error("503 del proveedor");
      return hit(q);
    });

    const result = await runBatch(rows, { client, bias: BIAS, retries: 0 });

    expect(result.summary).toMatchObject({ ok: 2, failed: 1 });
    expect(result.results[1].issues[0]).toMatchObject({ code: "provider_error" });
    expect(result.results[1].issues[0].detail).toContain("503");
  });

  it("reintenta antes de dar una fila por perdida", async () => {
    const { rows } = buildRows({ kind: "lines", lines: ["Av. Providencia 1234"] });
    let intentos = 0;
    const { client } = fakeClient((q) => {
      intentos += 1;
      if (intentos < 3) throw new Error("red caída");
      return hit(q);
    });

    const result = await runBatch(rows, { client, bias: BIAS, retries: 2 });

    expect(intentos).toBe(3);
    expect(result.summary.ok).toBe(1);
  });

  it("sin resultado del proveedor la fila queda fallida, no reintentada eternamente", async () => {
    const { rows } = buildRows({ kind: "lines", lines: ["Calle que no existe 99999"] });
    const { client, calls } = fakeClient(() => null);

    const result = await runBatch(rows, { client, bias: BIAS });

    expect(calls).toHaveLength(1);
    expect(result.results[0].issues[0].code).toBe("no_result");
  });

  it("cancelar detiene el lote y deja lo no procesado pendiente", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(20) });
    const controller = new AbortController();
    const { client, calls } = fakeClient((q, i) => {
      if (i === 2) controller.abort();
      return hit(q);
    });

    const result = await runBatch(rows, {
      client,
      bias: BIAS,
      concurrency: 1,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(calls.length).toBeLessThan(20);
    expect(result.summary.pending).toBeGreaterThan(0);
  });

  it("respeta el ritmo mínimo entre consultas", async () => {
    vi.useFakeTimers();
    try {
      const { rows } = buildRows({ kind: "lines", lines: linesFor(4) });
      const { client, calls } = fakeClient((q) => hit(q));

      const running = runBatch(rows, { client, bias: BIAS, concurrency: 4, minIntervalMs: 500 });
      await vi.advanceTimersByTimeAsync(0);
      // Con 4 workers pero un ritmo de 500 ms, solo una consulta salió.
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.length).toBeLessThanOrEqual(3);

      await vi.advanceTimersByTimeAsync(5000);
      await running;
      expect(calls).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retomar no vuelve a consultar lo ya resuelto", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(5) });
    const primera = fakeClient((q, i) => {
      if (i >= 2) throw new Error("se cayó la red");
      return hit(q);
    });
    const parcial = await runBatch(rows, { client: primera.client, bias: BIAS, concurrency: 1, retries: 0 });
    expect(parcial.summary.ok).toBe(2);

    const segunda = fakeClient((q) => hit(q));
    const completa = await runBatch(rows, {
      client: segunda.client,
      bias: BIAS,
      previous: parcial.results.filter((r) => r.status === "ok"),
    });

    expect(segunda.calls).toHaveLength(3);
    expect(completa.summary.ok).toBe(5);
  });

  it("marca como incierto el punto que quedó lejos de todo el resto", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(9) });
    const { client } = fakeClient((q, i) =>
      i === 8 ? hit(q, 20.02, -75.82) : hit(q, -33.44 + i * 0.01, -70.65 + i * 0.01),
    );

    const result = await runBatch(rows, { client, bias: BIAS });

    expect(result.results[8].status).toBe("uncertain");
    expect(result.results[8].issues.map((x) => x.code)).toContain("far_from_batch");
    expect(result.summary.ok).toBe(8);
  });

  it("la comuna declarada viaja como dato estructurado, no pegada al texto", async () => {
    const parsed = { kind: "table" as const, delimiter: "\t" as const, headers: ["Calle", "Número", "Comuna"], rows: [["Av. Grecia", "3000", "Ñuñoa"]] };
    const { rows } = buildRows(parsed);
    const recibido: Array<{ query: string; area?: string }> = [];
    const client: GeoClient = {
      autocomplete: async () => [],
      reverse: async () => null,
      async geocode(query, _bias, options) {
        recibido.push({ query, area: options?.adminArea?.name });
        return hit(query);
      },
    };

    await runBatch(rows, { client, bias: BIAS });

    expect(recibido[0]).toEqual({ query: "Av. Grecia 3000", area: "Ñuñoa" });
  });
});

describe("límite de cuota", () => {
  it("espera y reintenta ante un rechazo por límite, en vez de darlo por fallido", async () => {
    vi.useFakeTimers();
    try {
      const { rows } = buildRows({ kind: "lines", lines: ["Av. Providencia 1234"] });
      let intentos = 0;
      const { client } = fakeClient((q) => {
        intentos += 1;
        if (intentos === 1) throw new Error("rate_limited");
        return hit(q);
      });

      const running = runBatch(rows, { client, bias: BIAS, rateLimitWaitMs: 5000 });
      await vi.advanceTimersByTimeAsync(1000);
      // Con el backoff de red (300 ms) ya habría reintentado; con el de
      // cuota todavía no, que es justo la diferencia.
      expect(intentos).toBe(1);

      await vi.advanceTimersByTimeAsync(8000);
      const result = await running;
      expect(intentos).toBe(2);
      expect(result.summary.ok).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("informa que está en pausa mientras espera la cuota", async () => {
    vi.useFakeTimers();
    try {
      const { rows } = buildRows({ kind: "lines", lines: ["Av. Providencia 1234"] });
      let intentos = 0;
      const { client } = fakeClient((q) => {
        intentos += 1;
        if (intentos === 1) throw new Error("429 Too Many Requests");
        return hit(q);
      });
      const progreso: BatchProgress[] = [];

      const running = runBatch(rows, {
        client,
        bias: BIAS,
        rateLimitWaitMs: 5000,
        onProgress: (p) => progreso.push({ ...p }),
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(progreso.some((p) => p.paused)).toBe(true);

      await vi.advanceTimersByTimeAsync(8000);
      await running;
      expect(progreso[progreso.length - 1].paused).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("los reintentos de cuota no consumen los de red", async () => {
    const { rows } = buildRows({ kind: "lines", lines: ["Av. Providencia 1234"] });
    let intentos = 0;
    const { client } = fakeClient(() => {
      intentos += 1;
      throw new Error(intentos <= 2 ? "rate_limited" : "red caída");
    });

    const result = await runBatch(rows, {
      client,
      bias: BIAS,
      retries: 2,
      rateLimitRetries: 2,
      rateLimitWaitMs: 1,
    });

    // 2 rechazos por cuota + 1 intento tras la espera + 2 reintentos de red.
    expect(intentos).toBe(5);
    expect(result.results[0].issues[0].detail).toContain("red caída");
  });

  it("el freno por cuota alcanza a todo el lote, no solo a la fila rechazada", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(6) });
    /*
     * El servicio rechaza las 3 primeras consultas: es lo que pasa cuando
     * varios workers chocan a la vez contra el límite. Con reintento por
     * fila, los otros seguirían consultando durante la espera; con freno
     * compartido, nadie consulta hasta que se libera.
     */
    let rechazos = 0;
    const durante: number[] = [];
    const { client } = fakeClient((q) => {
      if (rechazos < 3) {
        rechazos += 1;
        throw new Error("rate_limited");
      }
      durante.push(Date.now());
      return hit(q);
    });

    const t0 = Date.now();
    const result = await runBatch(rows, {
      client,
      bias: BIAS,
      concurrency: 3,
      rateLimitWaitMs: 200,
    });

    expect(result.summary.failed).toBe(0);
    expect(result.summary.ok).toBe(6);
    // Ninguna consulta exitosa ocurrió antes de que terminara la espera.
    expect(Math.min(...durante) - t0).toBeGreaterThanOrEqual(200);
  });

  it("baja el ritmo para el resto del lote tras chocar con el límite", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(4) });
    let primera = true;
    const momentos: number[] = [];
    const { client } = fakeClient((q) => {
      if (primera) {
        primera = false;
        throw new Error("rate_limited");
      }
      momentos.push(Date.now());
      return hit(q);
    });

    await runBatch(rows, { client, bias: BIAS, concurrency: 1, rateLimitWaitMs: 50 });

    // Sin freno adaptativo las consultas saldrían pegadas una a otra.
    const separaciones = momentos.slice(1).map((m, i) => m - momentos[i]);
    expect(Math.max(...separaciones)).toBeGreaterThanOrEqual(200);
  });
});

describe("estimateBatchMs", () => {
  it("estima por el ritmo del proveedor cuando ese es el freno", () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(100) });
    expect(estimateBatchMs(rows, { concurrency: 3, minIntervalMs: 500 })).toBe(50_000);
  });

  it("no cuenta los duplicados, que no se consultan", () => {
    const { rows } = buildRows({ kind: "lines", lines: ["Calle 1 100", "Calle 1 100", "Calle 2 100"] });
    expect(estimateBatchMs(rows, { concurrency: 1, minIntervalMs: 1000 })).toBe(2000);
  });
});

describe("ahorro de consultas", () => {
  it("resuelve coordenadas pegadas sin gastar una consulta", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: [
        "-33.4489, -70.6693",
        "Av. Providencia 1234, Providencia",
        "https://www.google.com/maps/@-33.4372,-70.6506,17z",
      ],
    });
    const { client, calls } = fakeClient((q) => hit(q));

    const result = await runBatch(rows, { client, bias: BIAS });

    // Solo la dirección de texto llegó al proveedor.
    expect(calls.map((c) => c.query)).toEqual(["Av. Providencia 1234, Providencia"]);
    expect(result.summary.ok).toBe(3);
    expect(result.results[0].value).toMatchObject({ lat: -33.4489, lng: -70.6693, precision: "exact" });
    expect(result.results[2].value).toMatchObject({ lat: -33.4372, lng: -70.6506 });
  });

  it("cuenta las filas resueltas sin consultar", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: ["-33.4489, -70.6693", "Av. Providencia 1234", "AV. PROVIDENCIA 1234"],
    });
    const { client, calls } = fakeClient((q) => hit(q));
    const progreso: BatchProgress[] = [];

    await runBatch(rows, { client, bias: BIAS, onProgress: (p) => progreso.push({ ...p }) });

    expect(calls).toHaveLength(1);
    // Una por coordenadas + una por repetida.
    expect(progreso[progreso.length - 1].saved).toBe(2);
  });

  it("el tipo de vía no rompe la deduplicación", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: [
        "Av. Providencia 1234, Providencia",
        "Avenida Providencia 1234, Providencia",
        "AV PROVIDENCIA 1234, PROVIDENCIA",
        "Providencia 1234, Providencia",
        "Los Leones 220, Providencia",
      ],
    });
    const { client, calls } = fakeClient((q) => hit(q));

    const result = await runBatch(rows, { client, bias: BIAS });

    // Cuatro formas de escribir lo mismo + una distinta = 2 consultas.
    expect(calls).toHaveLength(2);
    expect(result.summary.ok).toBe(5);
  });

  it("no confunde alturas distintas de la misma calle", async () => {
    const { rows } = buildRows({
      kind: "lines",
      lines: ["Los Leones 220, Providencia", "Los Leones 240, Providencia"],
    });
    const { client, calls } = fakeClient((q) => hit(q));
    await runBatch(rows, { client, bias: BIAS });
    expect(calls).toHaveLength(2);
  });
});

describe("estimación de tiempo restante", () => {
  it("reacciona cuando el lote se frena, en vez de quedarse en el ritmo inicial", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(30) });
    // Las primeras 10 salen rápido; de ahí en adelante, cinco veces más lento.
    const { client } = fakeClient(async (q, i) => {
      await new Promise((r) => setTimeout(r, i < 10 ? 2 : 30));
      return hit(q);
    });
    const progreso: BatchProgress[] = [];

    await runBatch(rows, { client, bias: BIAS, concurrency: 1, onProgress: (p) => progreso.push({ ...p }) });

    const rapido = progreso.find((p) => p.done === 8 && p.etaMs !== null)?.etaMs ?? 0;
    const lento = progreso.find((p) => p.done === 25 && p.etaMs !== null)?.etaMs ?? 0;
    // Con promedio acumulado, la estimación por fila apenas se movería.
    const porFilaRapido = rapido / 22;
    const porFilaLento = lento / 5;
    expect(porFilaLento).toBeGreaterThan(porFilaRapido * 3);
  });
});

describe("el lote se detiene, no la fila", () => {
  it("agotar los reintentos de cuota detiene el lote y deja pendiente, no fallida", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(6) });
    const { client, calls } = fakeClient(() => {
      throw new Error("rate_limited");
    });

    const result = await runBatch(rows, {
      client,
      bias: BIAS,
      concurrency: 3,
      rateLimitRetries: 1,
      rateLimitWaitMs: 1,
    });

    expect(result.stopReason).toBe("quota");
    expect(result.cancelled).toBe(true);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.pending).toBeGreaterThan(0);
    // No se siguió consultando fila por fila una vez decidido el freno.
    expect(calls.length).toBeLessThan(6 * 3);
  });

  it("el aviso preventivo de cuota (quota_exhausted) detiene sin gastar reintentos", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(4) });
    let intentos = 0;
    const { client } = fakeClient(() => {
      intentos += 1;
      throw new Error("quota_exhausted");
    });

    const result = await runBatch(rows, { client, bias: BIAS, concurrency: 1, rateLimitRetries: 4 });

    expect(result.stopReason).toBe("quota");
    // Una sola consulta por fila en vuelo, no cuatro intentos de retry.
    expect(intentos).toBeLessThanOrEqual(2);
    expect(result.summary.pending).toBeGreaterThan(0);
  });

  it("una credencial rechazada detiene el lote de inmediato, sin reintentar", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(5) });
    let intentos = 0;
    const { client } = fakeClient(() => {
      intentos += 1;
      throw new Error("provider_auth_error");
    });

    const result = await runBatch(rows, { client, bias: BIAS, concurrency: 1, retries: 3 });

    expect(result.stopReason).toBe("auth");
    expect(intentos).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(result.summary.pending).toBeGreaterThan(0);
  });

  it("fallas consecutivas del proveedor se leen como caída, no como direcciones malas", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(20) });
    const { client, calls } = fakeClient(() => {
      throw new Error("502 del proveedor");
    });

    const result = await runBatch(rows, { client, bias: BIAS, concurrency: 1, retries: 0 });

    expect(result.stopReason).toBe("service_down");
    // Se detuvo bastante antes de gastar las 20 consultas.
    expect(calls.length).toBeLessThan(20);
    expect(result.summary.pending).toBeGreaterThan(0);
  });

  it("una racha corta de fallas no detiene el lote (por debajo del umbral)", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(3) });
    const { client } = fakeClient((q, i) => {
      if (i < 2) throw new Error("503 pasajero");
      return hit(q);
    });

    const result = await runBatch(rows, { client, bias: BIAS, concurrency: 1, retries: 0 });

    expect(result.stopReason).toBeNull();
    expect(result.summary.failed).toBe(2);
    expect(result.summary.ok).toBe(1);
  });

  it("un éxito resetea la racha de fallas del proveedor", async () => {
    const { rows } = buildRows({ kind: "lines", lines: linesFor(9) });
    // Falla, éxito, falla, éxito... nunca 5 seguidas: no debe detenerse.
    const { client } = fakeClient((q, i) => {
      if (i % 2 === 0) throw new Error("503 intermitente");
      return hit(q);
    });

    const result = await runBatch(rows, { client, bias: BIAS, concurrency: 1, retries: 0 });

    expect(result.stopReason).toBeNull();
    expect(result.summary.ok).toBe(4);
    expect(result.summary.failed).toBe(5);
  });
});
