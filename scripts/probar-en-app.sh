#!/usr/bin/env bash
#
# Prueba el código ACTUAL de elementos (sin commitear ni publicar) dentro de
# otra app que lo consume, por ejemplo el optimizador de rutas.
#
# Empaqueta geo-core, address-input y address-batch tal como se publicarían
# (cada `npm pack` compila su dist) y los instala en la app con --no-save:
# no toca su package.json ni su package-lock.json, así que no hay nada que
# deshacer antes de commitear en esa app.
#
# Uso:
#   elementos/scripts/probar-en-app.sh ../optimizador-rutas/app
#
# Volver a la versión publicada (en la carpeta de la app):
#   npm install
#
# Después de instalar hay que reiniciar el servidor de desarrollo de la app:
# Next.js guarda en caché lo que hay en node_modules.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Uso: $0 <carpeta-de-la-app>" >&2
  exit 1
fi

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
APP="$(cd "$1" && pwd)"
if [ ! -f "$APP/package.json" ]; then
  echo "No encuentro package.json en $APP" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Empaquetando desde $RAIZ ..."
for paquete in geo-core address-input address-batch; do
  (cd "$RAIZ/packages/$paquete" && npm pack --silent --pack-destination "$TMP" >/dev/null)
  echo "  listo: $paquete"
done

echo "Instalando en $APP (sin modificar package.json ni package-lock.json) ..."
(cd "$APP" && npm install --no-save "$TMP"/*.tgz)

echo
echo "Listo. Reinicia el servidor de desarrollo de la app para ver los cambios."
echo "Para volver a lo publicado: (cd \"$APP\" && npm install)"
