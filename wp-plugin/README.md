# wp-plugin/

Plugin de WordPress (`allride-geocodificador/`) para instalar manualmente vía
wp-admin — no es un paquete npm, no lo toca `npm install` ni los workspaces.

## Qué contiene

```
allride-geocodificador/
  allride-geocodificador.php   punto de entrada, cabecera del plugin
  includes/settings.php        Ajustes → AllRide Geocodificador
  includes/shortcode.php       registra [allride_geocodificador]
  assets/                      bundle construido por packages/wp-embed
                                (NO editar a mano — se pisa en cada build)
  readme.txt
```

## Actualizar el bundle

```bash
npm run build -w @allride/wp-embed
```

Compila `packages/wp-embed` y copia el resultado a `assets/` acá (ver
`packages/wp-embed/copy-to-plugin.mjs`). Correr esto después de cualquier
cambio en `@allride/address-batch` o `@allride/geo-core` que deba llegar al
sitio — el plugin no reconstruye nada por su cuenta, solo sirve archivos
estáticos.

## Empaquetar para subir a WordPress

```bash
cd wp-plugin
zip -r allride-geocodificador.zip allride-geocodificador -x '*.DS_Store'
```

El .zip resultante se sube desde Plugins → Añadir nuevo → Subir plugin.

## Configurar

Después de activar: Ajustes → AllRide Geocodificador → pegar la URL del
backend (`packages/wp-geocoder-api`, desplegado en Vercel — ver su README).
Sin esa URL el shortcode muestra un aviso (solo a administradores) en vez de
la herramienta.
