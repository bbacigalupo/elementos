/**
 * Copia el bundle recién construido a wp-plugin/allride-geocodificador/assets/,
 * que es lo que el plugin de WordPress encola de verdad — sin este paso, un
 * `npm run build` acá no llega al plugin y queda sirviendo una versión vieja.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = join(root, "packages", "wp-embed", "dist");
const assets = join(root, "wp-plugin", "allride-geocodificador", "assets");

await mkdir(assets, { recursive: true });
for (const file of ["allride-address-batch.js", "allride-address-batch.css"]) {
  await copyFile(join(dist, file), join(assets, file));
  console.log(`copiado wp-embed/dist/${file} → wp-plugin/allride-geocodificador/assets/${file}`);
}
