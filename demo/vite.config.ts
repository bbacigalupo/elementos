import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type PluginOption } from "vite";
// Imports relativos con extensión .ts: esbuild los inlinea al compilar esta
// config, así el middleware corre sin build previo de los paquetes.
import { createProvider } from "../packages/geo-core/src/providers/index.ts";
import { createMemoryRateLimit } from "../packages/geo-core/src/http/handlers.ts";
import { createNodeGeoMiddleware } from "../packages/geo-core/src/http/node.ts";

/**
 * El plugin geoProxy monta los handlers del contrato HTTP en el dev server
 * de Vite — la misma pieza que en producción se monta en Next.js, Express o
 * cualquier backend con Request/Response estándar.
 */
function geoProxy(): PluginOption {
  return {
    name: "geo-proxy",
    configureServer(server) {
      const apiKey = process.env.LOCATIONIQ_KEY;
      const middleware = createNodeGeoMiddleware({
        basePath: "/api/geo",
        provider: createProvider(apiKey ? { name: "locationiq", apiKey } : { name: "photon" }),
        rateLimit: createMemoryRateLimit(300, 60),
      });
      server.middlewares.use((req, res, next) => void middleware(req, res, next));
    },
  };
}

export default defineConfig({
  plugins: [react(), geoProxy()],
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
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
