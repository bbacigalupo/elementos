import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { GeoClient, GeocodeOutcome } from "@allride/geo-core";
import {
  createBatchApiHandlers,
  createCorrectionHandlers,
  createMemoryStore,
  generateApiKey,
  hashApiKey,
  runRetentionLoop,
  runWorkerLoop,
  verifyWebhookSignature,
  type PublicBatchJob,
} from "../src/index.ts";

/**
 * Demo end-to-end de un "sistema externo" real hablando con
 * `@allride/geo-batch-api` por HTTP — no por import directo, como haría de
 * verdad un ERP o un sistema de nóminas ajeno a este monorepo. Ejercita el
 * ciclo completo de los 9 pasos del paquete en un solo recorrido:
 *
 *   crear el trabajo → el worker lo procesa → llega el webhook `batch.done`
 *   → se detecta una fila incierta → se emite un link firmado → alguien SIN
 *   clave de API la corrige por ese link → llega el webhook
 *   `batch.row_corrected` → se borra el trabajo.
 *
 * Corre solo, sin proveedor de geocoding real ni clave de LocationIQ: usa un
 * `GeoClient` de mentira con dos direcciones fijas, una que "sale bien" y
 * otra a la que deliberadamente le falta la altura, para forzar el camino
 * de corrección sin depender de qué tan buena esté la cuota del día.
 *
 *   npx tsx examples/external-system-demo.mts
 *   (o: npm run example -w @allride/geo-batch-api)
 */

// ---------- narración ----------

let n = 0;
function paso(titulo: string): void {
  n += 1;
  console.log(`\n── Paso ${n}: ${titulo} ──`);
}
function log(...args: unknown[]): void {
  console.log("  ", ...args);
}

// ---------- servidor HTTP mínimo: Node IncomingMessage/ServerResponse ↔ Request/Response ----------

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(url, { method: req.method ?? "GET", headers, body });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function listen(handle: (req: Request) => Promise<Response>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      void toWebRequest(req).then(handle).then((r) => sendWebResponse(res, r));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ---------- GeoClient de mentira: dos direcciones fijas, resultado determinístico ----------

const DIRECCION_OK = "Av. Providencia 1234, Providencia";
const DIRECCION_INCIERTA = "Av. Apoquindo 4501, Las Condes";

function outcomeFalso(query: string): GeocodeOutcome | null {
  const ahora = new Date().toISOString();
  if (/providencia/i.test(query)) {
    return {
      matchedLevel: "address",
      value: {
        lat: -33.4269, lng: -70.6114,
        formatted: "Av. Providencia 1234, Providencia, Santiago",
        components: {
          street: "Av. Providencia", number: "1234", sublocality: null, commune: "Providencia",
          city: "Santiago", region: "Región Metropolitana de Santiago", postalCode: null, country: "CL",
        },
        precision: "rooftop", source: "search", provider: "demo-fake", capturedAt: ahora,
      },
    };
  }
  if (/apoquindo/i.test(query)) {
    // Deliberadamente SIN número: el proveedor "encontró la calle pero no
    // la altura" — es justo el caso que clasifica como incierta
    // (`no_house_number`) y dispara el camino de corrección de este demo.
    return {
      matchedLevel: "street",
      value: {
        lat: -33.4091, lng: -70.5478,
        formatted: "Av. Apoquindo, Las Condes, Santiago",
        components: {
          street: "Av. Apoquindo", number: null, sublocality: null, commune: "Las Condes",
          city: "Santiago", region: "Región Metropolitana de Santiago", postalCode: null, country: "CL",
        },
        precision: "street", source: "search", provider: "demo-fake", capturedAt: ahora,
      },
    };
  }
  return null;
}

const fakeClient: GeoClient = {
  autocomplete: async () => [],
  reverse: async () => null,
  geocode: async (query) => outcomeFalso(query),
};

// ---------- receptor de webhooks: lo que tendría el sistema externo ----------

interface EventoRecibido {
  type: string;
  firmaValida: boolean;
  body: { type: string; tenantId: string; job: PublicBatchJob; row?: unknown };
}

function crearReceptorWebhooks(secret: string) {
  const recibidos: EventoRecibido[] = [];

  const handle = async (req: Request): Promise<Response> => {
    const text = await req.text();
    const firma = req.headers.get("X-AllRide-Signature");
    const firmaValida = await verifyWebhookSignature(secret, text, firma);
    const body = JSON.parse(text);
    recibidos.push({ type: req.headers.get("X-AllRide-Event") ?? "?", firmaValida, body });
    return new Response(null, { status: 200 });
  };

  async function esperar(type: string, timeoutMs = 5000): Promise<EventoRecibido> {
    const limite = Date.now() + timeoutMs;
    for (;;) {
      const encontrado = recibidos.find((e) => e.type === type);
      if (encontrado) return encontrado;
      if (Date.now() > limite) throw new Error(`no llegó el webhook "${type}" en ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  return { handle, esperar };
}

// ---------- el demo ----------

async function main() {
  paso("Levantar el despliegue (lo que arma quien opera la API, no el sistema externo)");
  const store = createMemoryStore();
  const webhookSecret = "secreto-de-webhooks-solo-demo";
  const correctionSecret = "secreto-de-links-solo-demo";

  const claveApi = generateApiKey();
  await store.addApiKey({
    id: "key_demo",
    tenantId: "erp-demo",
    keyHash: await hashApiKey(claveApi),
    name: "Sistema externo de ejemplo",
    scopes: ["batches:write", "batches:read", "corrections:write"],
    dailyQuota: null,
    createdAt: new Date().toISOString(),
  });
  log(`clave de API emitida: ${claveApi.slice(0, 12)}…`);

  const receptor = crearReceptorWebhooks(webhookSecret);
  const { url: webhookUrl, close: cerrarReceptor } = await listen(receptor.handle);
  log(`receptor de webhooks del sistema externo escuchando en ${webhookUrl}`);

  const batchHandlers = createBatchApiHandlers({
    store,
    basePath: "/v1/batches",
    retentionDays: 30,
    // `baseUrl` es solo para armar la URL que se muestra al emitir el link
    // (quien la abre no la usa en este demo: se llama al token directo).
    correctionLinks: { secret: correctionSecret, baseUrl: "https://sistema-externo.example/corregir" },
  });
  const correctionHandlers = createCorrectionHandlers({
    store,
    basePath: "/v1/corrections",
    correctionLinks: { secret: correctionSecret },
    webhooks: { secret: webhookSecret, retryDelayMs: 100 },
  });
  const { url: apiUrl, close: cerrarApi } = await listen(async (req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/v1/corrections")) return correctionHandlers.handle(req);
    return batchHandlers.handle(req);
  });
  log(`API de lotes escuchando en ${apiUrl}`);

  const controladorWorker = new AbortController();
  const worker = runWorkerLoop({
    store,
    client: fakeClient,
    webhooks: { secret: webhookSecret, retryDelayMs: 100 },
    idlePollMs: 50,
    signal: controladorWorker.signal,
  });

  // Se corre igual que en producción, aunque en un demo de segundos no
  // llegue a purgar nada — la pieza que faltaba (paso de retención) es
  // justamente que esto exista y esté corriendo, no que tenga trabajo que
  // hacer en cada corrida puntual.
  const controladorRetencion = new AbortController();
  const retencion = runRetentionLoop({ store, intervalMs: 60 * 60_000, signal: controladorRetencion.signal });

  async function detenerTodo() {
    controladorWorker.abort();
    controladorRetencion.abort();
    await Promise.all([worker, retencion]);
    await Promise.all([cerrarApi(), cerrarReceptor()]);
  }

  try {
    // ---------- el sistema externo, desde acá ----------

    paso("El sistema externo crea el trabajo (POST /v1/batches, asíncrono — no `sync`)");
    const creado = await fetch(`${apiUrl}/v1/batches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${claveApi}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        addresses: [DIRECCION_OK, DIRECCION_INCIERTA],
        bias: { country: "CL" },
        webhookUrl,
        reference: "nomina-demo-agosto-2026",
      }),
    });
    assert.equal(creado.status, 201);
    const { job: trabajoCreado } = (await creado.json()) as { job: PublicBatchJob };
    log(`trabajo creado: ${trabajoCreado.id}, status=${trabajoCreado.status} (esperando al worker)`);

    paso("Llega el webhook `batch.done` — el sistema externo no hizo polling para saberlo");
    const avisoTerminado = await receptor.esperar("batch.done");
    assert.equal(avisoTerminado.firmaValida, true, "la firma HMAC del webhook debe verificar");
    assert.equal(avisoTerminado.body.job.status, "done");
    log(`firma verificada, job.status="${avisoTerminado.body.job.status}", queries=${avisoTerminado.body.job.queries}`);
    log(`(nunca viaja workerId/leaseUntil en el body: ${JSON.stringify(avisoTerminado.body.job).includes("workerId")})`);

    paso("Lo mismo, visto por polling — el camino de respaldo si no se corre un receptor propio");
    const jobId = trabajoCreado.id;
    const consultado = await fetch(`${apiUrl}/v1/batches/${jobId}`, {
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    const { job: trabajoConsultado } = (await consultado.json()) as { job: PublicBatchJob };
    log(`GET /v1/batches/${jobId} → status=${trabajoConsultado.status}, resumen=${JSON.stringify(trabajoConsultado.summary)}`);

    paso("Se leen las filas y se detecta la incierta");
    const filasRes = await fetch(`${apiUrl}/v1/batches/${jobId}/rows`, {
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    const { rows } = (await filasRes.json()) as { rows: Array<{ row: { id: string }; status: string; issues: Array<{ code: string }> }> };
    const incierta = rows.find((r) => r.status === "uncertain");
    assert.ok(incierta, "debería haber exactamente una fila incierta (la de Apoquindo, sin altura)");
    log(`fila incierta: ${incierta.row.id}, issue=${incierta.issues.map((i) => i.code).join(",")}`);

    paso("Se emite un link firmado para que alguien SIN clave de API la revise");
    const linkRes = await fetch(`${apiUrl}/v1/batches/${jobId}/rows/${incierta.row.id}/correction-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    assert.equal(linkRes.status, 201);
    const { token } = (await linkRes.json()) as { token: string };
    log(`token emitido (no lleva clave de API — autoriza solo esta fila): ${token.slice(0, 24)}…`);

    paso("Quien corrige abre el link — sin Authorization, solo el token en la URL");
    const filaPublica = await fetch(`${apiUrl}/v1/corrections/${token}`);
    assert.equal(filaPublica.status, 200);
    log("GET público de la fila: ok");

    const correccion = await fetch(`${apiUrl}/v1/corrections/${token}`, {
      method: "POST",
      body: JSON.stringify({
        lat: -33.4091, lng: -70.5478,
        formatted: "Av. Apoquindo 4501, Las Condes, Santiago",
        components: {
          street: "Av. Apoquindo", number: "4501", sublocality: null, commune: "Las Condes",
          city: "Santiago", region: "Región Metropolitana de Santiago", postalCode: null, country: "CL",
        },
        precision: "rooftop",
      }),
    });
    assert.equal(correccion.status, 200);
    log("POST de corrección: guardada");

    paso("Llega el webhook `batch.row_corrected` — el sistema externo se entera sin preguntar");
    const avisoCorregido = await receptor.esperar("batch.row_corrected");
    assert.equal(avisoCorregido.firmaValida, true);
    log(`fila corregida avisada: ${JSON.stringify(avisoCorregido.body.row).slice(0, 80)}…`);

    paso("El resumen del trabajo ya refleja la corrección");
    const final = await fetch(`${apiUrl}/v1/batches/${jobId}`, {
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    const { job: trabajoFinal } = (await final.json()) as { job: PublicBatchJob };
    assert.equal(trabajoFinal.summary.corrected, 1);
    assert.equal(trabajoFinal.summary.uncertain, 0);
    log(`resumen final: ${JSON.stringify(trabajoFinal.summary)}`);

    paso("El sistema externo borra el trabajo cuando ya extrajo lo que necesitaba");
    const borrado = await fetch(`${apiUrl}/v1/batches/${jobId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    assert.equal(borrado.status, 200);
    const yaNoExiste = await fetch(`${apiUrl}/v1/batches/${jobId}`, {
      headers: { Authorization: `Bearer ${claveApi}` },
    });
    assert.equal(yaNoExiste.status, 404);
    log("trabajo borrado y confirmado (404 al volver a pedirlo)");

    console.log("\n✔ Demo completo: los 9 pasos de @allride/geo-batch-api funcionando juntos, de punta a punta.\n");
  } finally {
    await detenerTodo();
  }
}

main().catch((err) => {
  console.error("\n✘ el demo falló:", err);
  process.exitCode = 1;
});
