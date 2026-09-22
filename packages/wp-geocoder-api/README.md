# @bbacigalupo/wp-geocoder-api

Backend del shortcode de WordPress (`allride-geocodificador`): `createGeoHandlers`
de `@bbacigalupo/geo-core` montado como funciones Edge de Vercel. Esconde la clave
de LocationIQ, aplica caché/cortacircuitos/rate limiting/cuota diaria — el
navegador del sitio nunca ve la clave, solo llama a este backend.

**En producción**: `https://wp-geocoder-api.vercel.app/api/geo` (proyecto
`all-ride1/wp-geocoder-api` en Vercel).

```
api/geo.ts              → /api/geo            (raíz, poco usada directo)
api/geo/[...path].ts    → /api/geo/geocode, /autocomplete, /reverse, /quota
lib/handlers.ts         → construcción única de createGeoHandlers, compartida
                           por los dos archivos de arriba — se compila a
                           lib/handlers.js con `npm run build` (ver más abajo,
                           es necesario para que Vercel la pueda desplegar)
```

## Desplegar (Vercel, proyecto `all-ride1/wp-geocoder-api`)

Tres cosas que costó descubrir a fuerza de deploys fallidos — documentadas
para no repetir la vuelta:

1. **Desplegar desde la raíz del monorepo, no desde esta carpeta.** El
   proyecto de Vercel tiene **Root Directory** = `packages/wp-geocoder-api`
   y **"Include files outside the Root Directory"** activado — pero eso solo
   sirve si Vercel tiene acceso al monorepo COMPLETO para empezar. Si corres
   `vercel --prod` parado en `packages/wp-geocoder-api`, el CLI solo sube esa
   carpeta sola (8 archivos) y `npm install` nunca encuentra
   `@bbacigalupo/geo-core`. Hay que enlazar el proyecto también desde la raíz
   (`vercel link --project wp-geocoder-api`, una vez) y desplegar desde ahí:
   ```bash
   cd elementos/            # raíz del monorepo, no packages/wp-geocoder-api
   npx vercel --prod --scope all-ride1
   ```
2. **`lib/handlers.ts` necesita compilarse a `.js` antes del deploy** —
   `npm run build` (ver `tsconfig.build.json`) lo compila a `lib/handlers.js`,
   al lado del `.ts`. El bundler de Vercel transpila automáticamente los
   archivos QUE ESTÁN DENTRO de `api/`, pero no los módulos que esos
   archivos importan desde afuera (`../lib/handlers.ts`) — sin este paso,
   el runtime de Node falla con `ERR_MODULE_NOT_FOUND` buscando un
   `handlers.ts` que no existe compilado. `vercel.json` ya lo encadena
   después del build de `geo-core`.
3. **Runtime Edge, no Node.js.** `export const config = { runtime: "edge" }`
   en los dos archivos de `api/`. Se probó sin esto (runtime Node.js por
   defecto) y `request.url` llegaba como ruta relativa
   (`/api/geo/quota?...`) en vez de una URL absoluta — `new URL(req.url)`
   dentro de `createGeoHandlers` tronaba con `ERR_INVALID_URL`. Edge sí
   entrega un `Request` conforme al estándar, con URL absoluta.

Variables de entorno (Vercel → Settings → Environment Variables, producción
— **nunca las pegues en el chat con el asistente**, se ingresan directo ahí
o por `vercel env add NOMBRE production` desde tu propia terminal):

```
LOCATIONIQ_KEY=<la clave real>
ALLOWED_ORIGIN=https://allrideapp.com
DAILY_QUOTA=450
```

`ALLOWED_ORIGIN` acepta varios orígenes separados por coma si hace falta
(ej. producción + un dominio de pruebas). Sin él, el módulo falla al
arrancar a propósito — mejor un deploy roto y visible que un backend abierto
sin CORS.

## Límite conocido

Caché, cortacircuitos, rate limiter y cuota diaria viven en memoria de cada
instancia — con varias instancias frías el tope real es `DAILY_QUOTA ×
instancias`, no `DAILY_QUOTA` a secas. Documentado también en
`geo-core/README.md`; si el volumen lo justifica, reemplazar por un contador
compartido (Vercel KV, Upstash Redis).

## Probar sin desplegar

```bash
LOCATIONIQ_KEY=... ALLOWED_ORIGIN=http://localhost:5199 npx tsx -e '
  import("./lib/handlers.ts").then(async ({ handlers }) => {
    const res = await handlers.handle(new Request("http://x/api/geo/quota"));
    console.log(await res.text());
  });
'
```

## Probar ya desplegado

```bash
curl -H "Origin: https://allrideapp.com" \
  "https://wp-geocoder-api.vercel.app/api/geo/quota"
```

El header `Access-Control-Allow-Origin` solo debe aparecer cuando el
`Origin` de la petición coincide con `ALLOWED_ORIGIN` — probarlo también con
un origen distinto para confirmar que no aparece (`curl` no aplica CORS por
su cuenta, así que hay que revisar el header a mano, no el código de
estado).
