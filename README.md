# Elementos AllRide

Monorepo de **elementos reutilizables** que se repiten en distintos flujos de AllRide
(encuestas, solicitud de viajes, formularios). Cada elemento se desarrolla y mejora de
forma independiente y se integra donde se necesite.

```
elementos/
├── packages/
│   ├── geo-core/        # @allride/geo-core — lógica pura de geolocalización (0 dependencias)
│   └── address-input/   # @allride/address-input — hook + componente React
└── demo/                # Playground (Vite) — npm run dev → http://localhost:5199
```

## Elemento 1: captura de direcciones

Captura una dirección de un usuario y entrega **siempre** la misma estructura
(`LocationValue`): coordenadas + dirección formateada con un estándar + componentes
(calle, comuna, región…) + metadatos de precisión y origen.

### Caminos de captura

Todos convergen en una pantalla de confirmación con pin ajustable — el *ground truth*
es el pin que la persona confirma, no lo que diga el geocoder:

```
escribir texto ──autocomplete──▶ elegir sugerencia ─┐
       │                                            │
       └──"Buscar de todas formas"──▶ geocode ──────┤
marcar en el mapa ──────────────────────────────────┼──▶ CONFIRMAR PIN ──▶ LocationValue
usar mi ubicación (GPS, opt-in) ────────────────────┤   (tocar mueve el pin,
ingresar coordenadas / link de Google Maps ─────────┘    arrastrar ajusta fino)
```

- Si el autocompletado no encuentra lo que buscas, el botón **"Buscar de todas formas"**
  fuerza una geocodificación del texto completo; si tampoco, el error ofrece marcar en el mapa.
- **Las salidas viven dentro del desplegable**, en un pie fijo que no scrollea con la lista:
  cuando el geocoder devuelve sugerencias que no son lo buscado, la lista tapaba las otras
  formas de capturar y el flujo quedaba sin salida visible.
- El componente **evalúa si las sugerencias calzan con lo escrito** (`assessSuggestions`):
  cobertura de tokens normalizados —sin tildes, con match por prefijo para texto a medio
  escribir— y presencia de la altura numérica. Si la mejor sugerencia cubre menos del 70%,
  o falta el número que la persona escribió, el pie cambia a *"¿Ninguna coincide con lo que
  escribiste?"*. Ejemplo real: escribir `las raíces 1700 peñalolén` y recibir "Las Raíces"
  (sin número) y "Las Perdices 1700" (otra calle) se detecta como match débil.
- Las sugerencias se **deduplican por texto visible**: los geocoders OSM repiten lugares y
  dos filas que se leen igual son imposibles de elegir (además de romper las keys de React).
- **Las coincidencias se resaltan** en el color de acento: al pintar lo que sí calza, lo que
  queda sin pintar delata la diferencia (`Las Perdices` vs `Las Raíces`). El color va con
  peso semibold para no depender solo de percibir el celeste.
- Al **marcar en el mapa**, el pin no cae en el centro genérico de la zona: si la persona
  alcanzó a escribir algo, ancla en la mejor coincidencia encontrada (aunque sea solo la
  calle o la comuna). Dentro del mapa hay además un botón **"Centrar en mi ubicación"** para
  saltar al GPS y seguir ajustando desde ahí.
- Las llamadas a proveedores **reintentan** 429/5xx y fallas de red con backoff exponencial
  y jitter (respetando `Retry-After`). Los servicios gratuitos responden 503 de forma
  intermitente y sin esto un tropiezo aislado deja a la persona viendo coordenadas crudas
  en vez de su dirección.
- El geocoder reporta el nivel real de match (`address` / `street` / `zone`) y la UI avisa
  cuando hay que ajustar el pin.
- Coordenadas manuales: acepta decimales (punto o coma), grados-minutos-segundos y URLs de
  Google Maps pegadas; detecta y corrige lat/lng invertidas usando la zona esperada.
- El mapa (Leaflet + tiles OSM) es ayuda visual, no requisito: si no carga en 6 s se puede
  confirmar igual con el texto. Leaflet y no MapLibre por compatibilidad con in-app
  browsers (WhatsApp/Instagram) y Android viejo — decisión validada en terreno.

### Apariencia del mapa

```tsx
<AddressInput
  map={{
    theme: "carto-positron",              // preset de tiles
    marker: { color: "#29A8E0" },          // o { html: "<svg>…</svg>" } para el logo
  }}
  …
/>
```

**Estilos de mapa** (`map.theme`), todos raster y compatibles con cualquier navegador:

| Preset | Look | Notas |
|---|---|---|
| `carto-positron` | Gris claro, casi sin íconos de POI | **Default.** El más limpio: nada compite con el pin |
| `carto-positron-xl` | Igual, con calles y nombres al doble | Menos detalle y algo menos nítido en pantallas densas |
| `carto-voyager` | Moderno, con color y contexto (parques, áreas) | Bastante más limpio que el estándar |
| `carto-dark` | Equivalente oscuro | Para interfaces en modo oscuro |
| `osm` | Estándar de OpenStreetMap | Cargado de POIs (farmacias, bancos, comercios) |

> **Cuidado con `detectRetina`.** El `{r}` de la URL ya pide tiles `@2x` por su cuenta en
> pantallas densas. Activar además `detectRetina` hace que Leaflet baje el tile a 128 px y
> traiga contenido de un zoom más profundo: los dos mecanismos se apilan, el contenido se
> reduce 4× en vez de 2× y los nombres de calle quedan ilegibles. Los presets no lo usan.

**Todos los presets son gratuitos y sin API key.** Los estilos CARTO solo piden atribución
(ya incluida en cada preset): no hay registro, cuenta ni costo. Se comprobó que las
alternativas "más limpias" que circulan no cumplen: Stadia Maps responde 401 sin key y Esri
restringe el uso comercial. Si en algún momento CARTO cambiara sus condiciones o hiciera
falta blindar el volumen, `map.tiles` acepta cualquier capa propia
(`{ url, attribution, subdomains, maxZoom, detectRetina }`) y el cambio es de una línea.

**Marcador** (`map.marker`): por defecto es el **pin de marca AllRide** — cuerpo celeste con
la manita del logo sobre disco blanco, borde blanco (lo que lo mantiene legible sobre mapa
claro, oscuro o satelital), sombra en el suelo y caída suave al aparecer. Opciones:

- `color`, `dotColor`, `outlineColor` — retiñe el pin (el logo sigue al `color`).
- `variant: "dot"` — pin sobrio con punto, para contextos donde la marca no aplica.
- `shadow`, `animate` — apagan la sombra y la animación.
- `html` — reemplaza el marcador por un SVG propio, junto con `size` y `anchor` (el punto
  del ícono que toca la coordenada).

Todo es SVG inline: sin assets externos ni requests adicionales, y el logo se reescala sin
perder nitidez en pantallas densas.

### Acotamiento de búsqueda (bias)

`GeoBias` combina capas: **país** (filtro duro, obligatorio), **centro + radio** (bias
blando por zona de operación) e idioma. El GPS es siempre opt-in por acción del usuario —
nunca prompt de permiso al cargar.

### Uso (React)

```tsx
import { AddressInput } from "@allride/address-input";
import { httpClient } from "@allride/geo-core";
import "@allride/address-input/styles.css";

<AddressInput
  client={httpClient("/api/geo")}
  bias={{ country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 }}
  modes={{ search: true, map: true, gps: true, coords: true }}
  label="¿Dónde comienza tu viaje?"
  onChange={(value) => …}   // LocationValue | null
  onMetrics={(m) => …}      // CaptureMetrics al confirmar
/>
```

¿Otra apariencia? Usa el hook headless `useAddressCapture(config)` con tu propia UI:
expone la máquina de estados completa (fases, sugerencias, acciones, errores).
El look del componente de referencia se ajusta con variables CSS (`--ari-accent`, etc.).

### Backend: contrato HTTP portable

El cliente nunca habla con el proveedor de geocoding (keys protegidas, rate limiting,
caché). Habla con tu backend vía tres endpoints GET:

| Endpoint | Parámetros | Respuesta |
|---|---|---|
| `{base}/autocomplete` | `q, country, lat?, lng?, radiusKm?, lang?, limit?` | `{ ok, suggestions: Suggestion[] }` |
| `{base}/geocode` | `q, country, lat?, lng?, radiusKm?, lang?` | `{ ok, outcome: GeocodeOutcome \| null }` |
| `{base}/reverse` | `lat, lng, lang?` | `{ ok, value: LocationValue \| null }` |

Errores: `{ ok: false, error }` con status 4xx/5xx.

Los handlers listos usan `Request`/`Response` estándar web — se montan en cualquier
backend moderno:

```ts
// Next.js — app/api/geo/[op]/route.ts
import { createGeoHandlers, createProvider, createMemoryRateLimit } from "@allride/geo-core";

const handlers = createGeoHandlers({
  provider: createProvider({ name: "locationiq", apiKey: process.env.LOCATIONIQ_KEY! }),
  rateLimit: createMemoryRateLimit(200, 60),
});
export const GET = (req: Request) => handlers.handle(req);
```

```ts
// Express / Node / Vite dev server
import { createNodeGeoMiddleware } from "@allride/geo-core/node";
app.use(createNodeGeoMiddleware({ basePath: "/api/geo", provider }));
```

Para otros lenguajes de backend, implementa el contrato de la tabla y el componente
funciona igual (`httpClient` solo conoce esas tres rutas).

### Proveedores

Intercambiables detrás de la interfaz `GeoProvider` — la UI no sabe cuál hay detrás:

| Proveedor | Costo | Autocomplete | Notas |
|---|---|---|---|
| `photon` | Gratis, sin key | ✅ | Diseñado para search-as-you-type. Sin filtro nativo de país (se filtra post-respuesta). **Default.** |
| `locationiq` | Free tier ~5.000 req/día | ✅ | Data OSM: permite almacenar resultados. `LOCATIONIQ_KEY`. |
| `nominatim` | Gratis | ❌ (TOS) | **Solo desarrollo**: máx 1 req/s, prohibido en producción a volumen. |
| `google` | Pagado | — | **Planificado**: Places (New) con session tokens. La interfaz ya lo contempla; falta solo el adapter. |

Todos los proveedores envían un **User-Agent** identificable (`DEFAULT_USER_AGENT`,
sobreescribible con `userAgent`). No es cortesía: el endpoint `reverse` de Photon responde
503 a toda petición sin él y `fetch` de Node no manda ninguno, así que sin esto el reverse
geocoding falla siempre desde el servidor. Nominatim además lo exige en sus TOS.

### División administrativa declarada (comuna)

Opcional, por despliegue. Cuando el dato tiene que ser limpio para análisis, se pasa un
catálogo y la persona elige antes de escribir la dirección:

```tsx
<AddressInput
  adminAreas={{ options: comunas, label: "Comuna", required: true }}
  minPrecision="street"
  privacyHint
  …
/>
```

La división elegida acota la búsqueda y **prevalece sobre lo que parsee el geocoder**: los
datos OSM en Chile devuelven `commune: "Santiago"` para direcciones que están en Peñalolén,
y esa variable suele ser clave para el análisis. Sin `adminAreas` el elemento funciona con
autocompletado libre, como antes.

`minPrecision` avisa —nunca bloquea— cuando el punto confirmado queda por debajo del nivel
pedido, y lo marca en las métricas (`belowMinPrecision`) para filtrar en el análisis.
`privacyHint` muestra el aviso para capturar domicilios particulares.

### Protección contra abuso y consumo excesivo

Las defensas vienen puestas por defecto: quien integra el elemento no debería tener que
acordarse de activarlas para que su despliegue esté sano.

**En el cliente** (menos llamadas por persona):

- Debounce de 300 ms y mínimo de 3 caracteres: no se consulta en cada tecla.
- Cancelación de la petición anterior al escribir la siguiente (`AbortController`).
- Las sugerencias traen el `LocationValue` completo: elegir una no gasta otra llamada.

**En el servidor** (menos llamadas en total, y protección del endpoint):

- **Caché compartida con fusión de peticiones**: la misma dirección se resuelve una vez
  para todas las personas, y veinte consultas idénticas simultáneas se convierten en una
  sola llamada al proveedor. Es lo que más reduce costo y cuota, y vuelve inofensivo el
  abuso más simple —repetir la misma consulta en bucle—. Respeta
  `capabilities.cacheable`: los proveedores OSM permiten almacenar resultados (ODbL),
  Google no.
- **Cortacircuitos**: tras varios fallos seguidos deja de llamar al proveedor por un rato.
  Sin él, una caída se amplifica por los reintentos y arriesga bloqueos por abuso en los
  tiers gratuitos.
- **Rate limiting activo por omisión** (120 req/min por IP, en memoria). El endpoint es
  público por necesidad —lo llama el navegador— y sin límite cualquier despliegue sería un
  proxy de geocoding gratis para terceros. Se reemplaza por uno compartido pasando
  `rateLimit`, o se desactiva explícitamente con `false`.
- **CORS con lista de orígenes**: se responde solo al origen que coincida. `"*"` se ignora
  con una advertencia, porque con comodín cualquier sitio podría gastar tu cuota.
- **Validación de entrada**: largo de la consulta (2–200), país en formato ISO, coordenadas
  dentro de rango, `limit` acotado a 1–10 y nombres de división administrativa hasta 120
  caracteres.
- **Las API keys nunca llegan al navegador**: todo pasa por el proxy propio.

Ajustes:

```ts
createProvider({
  name: "locationiq",
  apiKey: process.env.LOCATIONIQ_KEY!,
  cache: { ttlMs: 12 * 60 * 60 * 1000, maxEntries: 5000 }, // o `false`
  circuitBreaker: { failureThreshold: 5, resetMs: 30_000 }, // o `false`
});

createGeoHandlers({ provider, cors: ["https://encuestas.allrideapp.com"] });
```

**Límite conocido**: la caché y el rate limiter viven en memoria del proceso. En entornos
serverless (Vercel) cada instancia tiene los suyos, así que protegen menos de lo que
protegerían con un almacén compartido. Para volumen alto conviene pasar un `rateLimit`
respaldado en base de datos —como hace la encuesta de estudio-movilidad— y, llegado el
caso, una caché compartida.

### Versionado y consumo

Los paquetes se publican versionados; los consumidores fijan la versión y adoptan los
cambios cuando lo deciden — un ajuste al elemento no altera una encuesta en producción sin
que alguien lo apruebe.

```bash
npm run build     # compila ambos paquetes a dist/ (JS + tipos)
npm pack -w @allride/geo-core -w @allride/address-input
```

El playground consume el **código fuente** vía alias de Vite, así se itera sin recompilar;
`dist/` es solo lo que viaja a los consumidores.

### Desarrollo

```bash
npm install        # en elementos/
npm run dev        # playground en http://localhost:5199
npm test           # tests (parser de coordenadas)
npm run typecheck  # los 3 workspaces
```

El playground usa Photon por defecto; con `LOCATIONIQ_KEY` en el entorno, el proxy usa
LocationIQ. También está en `.claude/launch.json` como `elementos-demo`.

### Pendientes / ideas

- Adapter Google Places (New) con session tokens (autocomplete cobra por sesión).
- Bias por IP server-side cuando no hay `center` configurado.
- Caché de geocodificaciones en backend (legal con proveedores OSM).
- Publicación como paquetes npm privados cuando haya un segundo consumidor real
  (el primero será la encuesta de estudio-movilidad).
