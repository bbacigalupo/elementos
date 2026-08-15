/**
 * Copia assets que tsc no procesa (CSS) desde src/ a dist/.
 * Uso: node scripts/copy-assets.mjs <paquete> <archivo...>
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [pkg, ...assets] = process.argv.slice(2);
if (!pkg || assets.length === 0) {
  console.error("Uso: copy-assets.mjs <paquete> <archivo...>");
  process.exit(1);
}

for (const asset of assets) {
  const from = join(root, "packages", pkg, "src", asset);
  const to = join(root, "packages", pkg, "dist", asset);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
  console.log(`copiado ${pkg}/src/${asset} → dist/${asset}`);
}
