import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Connect, type PluginOption } from "vite";
// Imports relativos con extensión .ts: esbuild los inlinea al compilar esta
// config, así el middleware corre sin build previo de los paquetes.
import { createProvider } from "../packages/geo-core/src/providers/index.ts";
import { createBatchRateLimit } from "../packages/geo-core/src/http/handlers.ts";
import { createNodeGeoMiddleware } from "../packages/geo-core/src/http/node.ts";
import { createMemoryStore } from "../packages/geo-batch-api/src/memory-store.ts";
import { generateApiKey, hashApiKey } from "../packages/geo-batch-api/src/keys.ts";
import { createBatchApiHandlers } from "../packages/geo-batch-api/src/handlers.ts";
import { createCorrectionHandlers } from "../packages/geo-batch-api/src/correction-handlers.ts";

const raizElementos = fileURLToPath(new URL("..", import.meta.url));

/**
 * El plugin geoProxy monta los handlers del contrato HTTP en el dev server
 * de Vite — la misma pieza que en producción se monta en Next.js, Express o
 * cualquier backend con Request/Response estándar.
 */
function geoProxy(apiKey: string | undefined): PluginOption {
  return {
    name: "geo-proxy",
    configureServer(server) {
      const middleware = createNodeGeoMiddleware({
        basePath: "/api/geo",
        provider: createProvider(apiKey ? { name: "locationiq", apiKey } : { name: "photon" }),
        /*
         * Limitador de balde y no de ventana fija: con la ventana, un lote
         * de 500 direcciones se corta en seco al llegar al tope y el
         * navegador recibe cientos de errores. El balde deja arrancar de
         * corrido y después impone el ritmo sostenido.
         */
        rateLimit: createBatchRateLimit({ ratePerMinute: 240, burst: 600 }),
      });
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
}

/**
 * Puente Node/Connect genérico para cualquier juego de handlers portables
 * (`{ handle: (req: Request) => Promise<Response> }`). `geo-batch-api` no
 * trae su propio adapter de Node —a diferencia de geo-core, que tiene
 * `http/node.ts`— porque el paquete es agnóstico de runtime a propósito;
 * para el playground alcanza con extraer la misma lógica de puente una vez
 * y reusarla para los tres handlers.
 */
function bridge(basePath: string, handle: (req: Request) => Promise<Response>) {
  return async (req: Connect.IncomingMessage, res: import("node:http").ServerResponse, next: Connect.NextFunction) => {
    const host = req.headers.host ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith(basePath)) return next();

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;

    const response = await handle(new Request(url, { method: req.method ?? "GET", headers, body }));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}

/**
 * Monta la API de lotes (paso 14-18) para poder probar de punta a punta en
 * el playground: crear un trabajo, emitir un link de corrección, y que
 * `<CorrectionPage>` lo resuelva de verdad contra un servidor, no contra
 * datos inventados. Store en memoria — se pierde al reiniciar, que es
 * exactamente lo que corresponde a un playground.
 */
function batchApiProxy(apiKey: string | undefined): PluginOption {
  const store = createMemoryStore();
  let claveDemo = "";

  return {
    name: "batch-api-proxy",
    async configureServer(server) {
      claveDemo = generateApiKey();
      store.addApiKey({
        id: "key_demo",
        tenantId: "demo",
        keyHash: await hashApiKey(claveDemo),
        name: "Playground",
        scopes: ["batches:write", "batches:read", "corrections:write"],
        dailyQuota: null,
        createdAt: new Date().toISOString(),
      });
      // Se expone en un endpoint propio, no en el bundle: la clave sigue
      // siendo un secreto de servidor, el playground solo la necesita para
      // que la pestaña de la API pueda armar sus propias peticiones.
      server.middlewares.use("/api/demo-key", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ apiKey: claveDemo }));
      });

      const provider = createProvider(apiKey ? { name: "locationiq", apiKey } : { name: "photon" });
      const batchHandlers = createBatchApiHandlers({
        store,
        basePath: "/v1/batches",
        sync: { client: provider, maxRows: 25 },
        correctionLinks: {
          secret: "secreto-de-playground-no-usar-en-produccion",
          // Raíz del playground: `App.tsx` detecta `?token=` ahí y muestra
          // directo la pestaña de corrección, como haría cualquier página
          // montada en su propia ruta.
          baseUrl: "http://localhost:5199/",
        },
      });
      const correctionHandlers = createCorrectionHandlers({
        store,
        basePath: "/v1/corrections",
        // Solo el secreto: verificar un token no necesita saber a dónde
        // apunta la página (eso es cosa de quien lo EMITE, no de quien lo
        // valida) — `CorrectionHandlersOptions` lo tipa así a propósito.
        correctionLinks: { secret: "secreto-de-playground-no-usar-en-produccion" },
      });

      server.middlewares.use(bridge("/v1/batches", batchHandlers.handle));
      server.middlewares.use(bridge("/v1/corrections", correctionHandlers.handle));
    },
  };
}

export default defineConfig(({ mode }) => {
  // Prefijo vacío: LOCATIONIQ_KEY es una clave de servidor y no lleva el
  // prefijo VITE_ justamente para que nunca llegue al navegador.
  const env = loadEnv(mode, raizElementos, "");
  const apiKey = env.LOCATIONIQ_KEY || process.env.LOCATIONIQ_KEY;

  return {
    plugins: [react(), geoProxy(apiKey), batchApiProxy(apiKey)],
    envDir: raizElementos,
    resolve: {
      // El playground apunta al código fuente, no a dist: así se itera sin
      // recompilar. Los consumidores externos usan el dist publicado.
      alias: {
        "@allride/geo-core": fileURLToPath(new URL("../packages/geo-core/src/index.ts", import.meta.url)),
        "@allride/address-input/styles.css": fileURLToPath(
          new URL("../packages/address-input/src/styles.css", import.meta.url),
        ),
        "@allride/address-input": fileURLToPath(
          new URL("../packages/address-input/src/index.ts", import.meta.url),
        ),
        "@allride/address-batch/styles.css": fileURLToPath(
          new URL("../packages/address-batch/src/styles.css", import.meta.url),
        ),
        "@allride/address-batch": fileURLToPath(
          new URL("../packages/address-batch/src/index.ts", import.meta.url),
        ),
      },
    },
    optimizeDeps: {
      /*
       * SheetJS es CommonJS y hay que pre-empaquetarlo. Vite descubre las
       * dependencias recorriendo el grafo desde su propia raíz, y acá los
       * paquetes entran por alias a `../packages/*​/src`: el `import("xlsx")`
       * que vive ahí adentro queda fuera del rastreo y falla al resolverse.
       * Declararlo acá lo arregla; los consumidores que instalen el paquete
       * desde npm no lo necesitan, porque ahí `xlsx` es una dependencia
       * normal de su propio árbol.
       */
      include: ["xlsx"],
    },
    server: {
      port: 5199,
      strictPort: true,
    },
  };
});
