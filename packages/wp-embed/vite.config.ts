import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Bundle standalone: todo (React, ReactDOM, Leaflet, el `AddressBatch`
 * completo, su CSS) en un solo archivo IIFE que WordPress puede cargar con
 * un `<script>` normal, sin bundler propio del lado del sitio.
 *
 * `inlineDynamicImports: true` es la pieza no obvia: `address-batch` carga
 * Leaflet y `xlsx` con `import()` diferido a propósito (para no pagar su
 * peso si nadie usa el mapa o sube un Excel), pero un IIFE no puede resolver
 * un chunk async por su cuenta — no hay bundler del lado del sitio que lo
 * sirva. Se pierde la carga diferida (todo entra en el archivo único, más
 * pesado) a cambio de que funcione con un solo `<script>`, que es el punto
 * de este paquete.
 */
export default defineConfig({
  plugins: [react()],
  // Sin bundler propio del lado de WordPress no hay quien defina `process` —
  // algunas dependencias (React entre ellas) lo consultan igual para decidir
  // el modo. Se resuelve en build time, no queda ningún `process` en runtime.
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      "@bbacigalupo/geo-core": fileURLToPath(new URL("../geo-core/src/index.ts", import.meta.url)),
      "@bbacigalupo/address-input/styles.css": fileURLToPath(
        new URL("../address-input/src/styles.css", import.meta.url),
      ),
      "@bbacigalupo/address-input": fileURLToPath(new URL("../address-input/src/index.ts", import.meta.url)),
      "@bbacigalupo/address-batch/styles.css": fileURLToPath(
        new URL("../address-batch/src/styles.css", import.meta.url),
      ),
      "@bbacigalupo/address-batch": fileURLToPath(new URL("../address-batch/src/index.ts", import.meta.url)),
    },
  },
  optimizeDeps: {
    include: ["xlsx"],
  },
  build: {
    outDir: "dist",
    lib: {
      entry: fileURLToPath(new URL("src/main.tsx", import.meta.url)),
      name: "AllrideAddressBatch",
      formats: ["iife"],
      fileName: () => "allride-address-batch.js",
    },
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: (info) =>
          info.names?.[0]?.endsWith(".css") ? "allride-address-batch.css" : "assets/[name][extname]",
      },
    },
  },
});
