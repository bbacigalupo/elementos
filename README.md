# Elementos AllRide

Monorepo de **elementos reutilizables** que se repiten en distintos flujos de AllRide
(encuestas, solicitud de viajes, formularios). Cada elemento se desarrolla y mejora de
forma independiente y se integra donde se necesite.

```
elementos/
├── packages/
│   ├── geo-core/        # @allride/geo-core — lógica pura de geolocalización (0 dependencias)
│   ├── address-input/   # @allride/address-input — captura de UNA dirección
│   ├── address-batch/   # @allride/address-batch — geocodificación MASIVA
│   └── geo-batch-api/   # @allride/geo-batch-api — API para sistemas externos
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
  escribiste?"*. Ejemplo real: escribir `av. grecia 3000 ñuñoa` y recibir "Av. Grecia"
  (sin número) y "Av. Grecia Norte 3000" (otra calle) se detecta como match débil.
- Las sugerencias se **deduplican por texto visible**: los geocoders OSM repiten lugares y
  dos filas que se leen igual son imposibles de elegir (además de romper las keys de React).
- **Las coincidencias se resaltan** en el color de acento: al pintar lo que sí calza, lo que
  queda sin pintar delata la diferencia (`Av. Grecia Norte` vs `Av. Grecia`). El color va con
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

### La comuna correcta por país

OSM **no dice en qué campo viene la comuna**, y el campo cambia según la ciudad:

| Dirección | Comuna real | `suburb` | `city` |
|---|---|---|---|
| Av. Apoquindo 4501 | Las Condes | **Las Condes** | Santiago |
| Av. Grecia 3000 | Ñuñoa | **Ñuñoa** | Santiago |
| Moneda 1025 | Santiago | — | **Santiago** |
| Av. Pedro Montt 1900 (Valparaíso) | Valparaíso | Almendral | **Valparaíso** |

En el Gran Santiago la comuna está en `suburb` y `city` nombra a toda la
conurbación; en Valparaíso es exactamente al revés. **Preferir un campo fijo
acierta en una ciudad y falla en la otra.** Antes se usaba `city`, así que una
dirección de Las Condes se exportaba con comuna "Santiago" — un dato incorrecto
que se propaga a rutas, informes y decisiones.

La regla que sí funciona es preguntar **cuál de los valores es una comuna de
verdad**, y para eso hace falta la lista: el paquete trae las 346 comunas de
Chile (6 KB). `city` se conserva como lo que OSM dice que es — otro nivel, no un
error — y el barrio deja de repetir a la comuna.

Para otros países se registra su lista y el mapeo empieza a acertar ahí también:

```ts
import { registerAdminAreas } from "@allride/geo-core";

registerAdminAreas("MX", ["Cuauhtémoc", "Benito Juárez", "Miguel Hidalgo", …]);
```

Sin catálogo para un país, se mantiene la regla anterior (`city`, luego `town`).

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

## Elemento 2: geocodificación masiva

Recibe muchas direcciones en texto, las convierte a coordenadas y **separa las que se
pueden usar de las que hay que revisar**. Esa separación es todo el punto: en captura
individual la persona ve el resultado y lo corrige sola; en masivo nadie mira fila por
fila, así que un resultado mediocre entra al análisis como si fuera bueno.

```tsx
import { AddressBatch } from "@allride/address-batch";
import { httpClient } from "@allride/geo-core";
import "@allride/address-batch/styles.css";

<AddressBatch
  client={httpClient("/api/geo")}
  bias={{ country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 }}
  maxRows={100}                 // sin valor: sin tope
  concurrency={3}
  minIntervalMs={500}           // ritmo del proveedor
  storageKey="mi-app-lote"      // permite retomar un lote interrumpido
  onComplete={(r) => …}
/>
```

### Entrada

Cuatro caminos que terminan en la misma estructura:

| Camino | Detalle |
|---|---|
| Escribir | Una dirección por línea. No se busca mientras se escribe: se busca al final. |
| Pegar de Excel | Llega separado por tabuladores; aparece el mapeo de columnas. |
| Cargar CSV | Lector RFC 4180 real: una celda con saltos de línea o comas no desalinea la planilla. |
| Cargar Excel | `.xlsx/.xlsm/.xlsb/.xls/.ods`. Si el libro tiene varias hojas con datos, pregunta cuál. |

Hay **plantillas descargables** (`.xlsx`, con CSV como respaldo) para repartir a quien
tenga que llenarlas, con direcciones reales que de verdad geocodifican.

El criterio para decidir entre tabla y lista de líneas no es simétrico entre separadores,
y no puede serlo: **tabulador y punto y coma son siempre tabla; la coma, solo si hay
encabezados reconocibles**. `Av. Providencia 1234, Providencia, Santiago` es una
dirección, no tres columnas — y es justo el formato que se le pide a la gente.

Las **columnas que no se usan igual se conservan** y vuelven en la exportación: quien
carga una nómina con nombre, RUT y centro de costo espera recuperar su planilla con las
coordenadas al lado, no una tabla nueva que después tiene que cruzar a mano.

### Los tres estados

`classify.ts` reusa la evaluación de relevancia del elemento individual y le suma lo que
el masivo necesita:

| Motivo | Qué detecta |
|---|---|
| `no_house_number` | Se pidió una altura y solo se ubicó la calle. **La herramienta pública actual reporta esto como "OK".** |
| `number_mismatch` | Devolvió otra altura. |
| `street_mismatch` | Devolvió **otra calle**. Pedir `Av. Grecia 3000` y recibir `Av. Grecia Norte 3000` cubre 75% de los tokens, con precisión de dirección exacta: se ve impecable y está en otra calle. |
| `zone_only` | Cayó en el centro de una comuna, no en una dirección. |
| `weak_match` | Lo devuelto no se parece en general a lo pedido. |
| `outside_admin_area` | El punto no está en la comuna declarada. |
| `far_from_bias` | Quedó lejísimos de la zona de operación. |
| `far_from_batch` | Quedó lejos de **todo el resto del lote**. Es la red que atrapa el "Santiago" que aterriza en Santiago de Cuba: cada punto se ve perfecto de a uno y solo el conjunto delata que uno está a 6.000 km. Usa mediana y no promedio — unos pocos disparates arrastran el promedio hasta dejar de parecer disparates. |

### Revisión y corrección

El resumen **funciona como filtro**: cada contador lleva a sus filas. Cada fila incierta
explica en palabras qué le pasa. Las filas conservan su índice original de la planilla al
filtrar, para poder ir a esa fila en el Excel de origen.

Lo incierto y lo fallido se **corrigen a mano con el elemento 1**, fila por fila: el pin
que la persona confirma reemplaza al del geocoder y queda marcado como
`corregido a mano` en la exportación. La corrección **se propaga a las filas repetidas**:
corregir solo la que se está mirando dejaría a las otras con un punto que ya se sabe
equivocado, y nadie volvería a revisarlas porque el resumen mostraría el problema como
resuelto.

El mapa muestra **lo filtrado, no todo**: filtrando por inciertas se ve dónde se
concentran los problemas geográficamente. Renderiza en canvas, así que miles de puntos no
necesitan una librería de clustering.

### Salida

`.xlsx`, `.csv` y **copiar al portapapeles** en TSV para pegar directo en una planilla.
Los tres salen de la misma tabla, así que no pueden decir cosas distintas.

- En el `.xlsx` las coordenadas son **números de verdad**, no texto: si no, no se pueden
  promediar ni graficar, y Excel marca cada fila con el triangulito verde.
- El `.csv` sale con `;`, coma decimal y BOM. Con coma como separador, Excel en español
  mete todo en la primera columna; sin BOM, "Peñalolén" llega como "PeÃ±alolÃ©n".
- Las filas fallidas **aparecen marcadas**, no desaparecen: una planilla a la que le
  faltan doce filas se cruza mal y nadie nota lo que falta.

### Lo que cuesta un lote, y cómo no romperlo

Un lote de 500 direcciones son 500 consultas seguidas del mismo navegador. Eso rompe las
defensas pensadas para captura individual, y hay que configurarlo a propósito:

**En el proxy** — `createMemoryRateLimit` (ventana fija, el default) **no sirve para
lotes**: reparte permisos en tajadas de un minuto, así que la consulta 121 no se demora,
falla. Usa el limitador de balde:

```ts
createGeoHandlers({
  provider,
  rateLimit: createBatchRateLimit({ ratePerMinute: 240, burst: 600 }),
});
```

**En el motor** — un 429 del proveedor se reconoce como límite de cuota y **frena el lote
completo**, no solo la fila rechazada, y baja el ritmo para lo que queda. Reintentar fila
por fila es la granularidad equivocada: mientras una espera, los otros workers siguen
golpeando el servicio y agotan sus reintentos en paralelo.

> Medido con 250 direcciones reales contra LocationIQ free: **62 fallidas** con reintento
> por fila (direcciones perfectamente geocodificables, descartadas por cuota), **9** con
> freno compartido.

**Consultas que nunca se envían.** Cada una de estas ahorra cuota sin perder nada:

| Ahorro | Detalle |
|---|---|
| Direcciones repetidas | Se consultan una sola vez y el resultado se copia al resto. |
| Tipo de vía normalizado | `Av. Providencia 1234`, `Avenida Providencia 1234` y `Providencia 1234` son **una** consulta, no tres. En una nómina que llenó cada persona por su cuenta, esto es lo normal. |
| Filas que ya son coordenadas | `-33.4489, -70.6693` o un link de Google Maps pegado se resuelven localmente, con `precision: "exact"`. Antes se mandaban al geocoder: gastaban cuota **y volvían fallidas**. |
| Volver a procesar la misma lista | Lo ya resuelto en la sesión no se vuelve a consultar. Editar 3 líneas de 500 cuesta 3 consultas, no 500 — y el flujo real es justamente iterativo. |
| Caché del proxy | Compartida entre todas las personas, con fusión de peticiones idénticas en vuelo. |

Y hay tope de lectura de archivo (`readLimit`, 50.000 filas) para que una planilla con un
millón de filas usadas por accidente no cuelgue la pestaña; con `storageKey` el avance se
guarda cada 2 segundos para **retomar un lote interrumpido** sin volver a pagar la cuota
ya consumida.

### Que la espera se sienta corta

Un lote grande tarda minutos y no hay forma de acelerarlo más allá de la cuota del
proveedor. Lo que sí se puede es que ese rato no se sienta como una pantalla congelada:

- **La tabla se llena en vivo.** Ver direcciones reales apareciendo es progreso de
  contenido; una barra es progreso abstracto. Es la palanca más fuerte que existe acá.
- **La barra va segmentada por estado** — se ve venir si el lote viene torcido, sin
  esperar al final.
- **El tiempo restante se calcula con el ritmo de las últimas 20 filas**, no con el
  promedio desde el arranque. Con promedio acumulado la estimación se congela cuando el
  servicio empieza a frenar: en la corrida de 250 mostró "faltan 2 min" en seis lecturas
  seguidas mientras se resolvían 78 filas.
- **El título de la pestaña muestra el porcentaje** (`45% · Geocodificando`), porque a los
  dos minutos la persona se fue a otra pestaña. Al terminar, una notificación del sistema
  **solo si el permiso ya estaba dado** — nunca se pide.
- **La pausa por cuota trae cuenta regresiva.** Esperar mirando un reloj se hace bastante
  más corto que esperar mirando nada.
- **Tips rotativos** que explican algo usable al terminar, no relleno para llenar el
  silencio.
- **El cierre encabeza con la tarea, no con la tabla**: *"241 listas. 9 necesitan tu
  revisión"* convierte un muro de 250 filas en un trabajo de nueve.

Todo lo animado respeta `prefers-reduced-motion`.

### Peso

`xlsx` y `leaflet` se cargan con `import()` diferido. Un despliegue que solo pega texto y
exporta CSV no baja ninguno de los dos:

| Se carga | Cuándo |
|---|---|
| `leaflet` (~150 KB) | Al abrir el mapa |
| `@allride/address-input` | Al pulsar "Corregir" en una fila |
| `xlsx` (~970 KB) | Al cargar un Excel o pedir una plantilla |

> **Sobre `xlsx`**: el paquete de npm quedó congelado en 0.18.5, con advisories abiertos
> de prototype pollution y ReDoS. Importa de verdad acá, porque este código parsea
> archivos que sube gente de afuera. SheetJS publica las versiones corregidas en su propio
> registro:
>
> ```bash
> npm install "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
> ```
>
> Es una peer dependency **opcional**: sin ella el elemento funciona con texto y CSV, y lo
> dice en pantalla en vez de romperse.


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

El playground usa Photon por defecto. Para probar con LocationIQ, copia `.env.example` a
`.env.local` (en `elementos/`, no en `demo/`) y pon la clave ahí: la lee `vite.config.ts`
con `loadEnv` y **no lleva prefijo `VITE_` justamente para que nunca llegue al navegador**.
También está en `.claude/launch.json` como `elementos-demo`.

### Pendientes / ideas

- Adapter Google Places (New) con session tokens (autocomplete cobra por sesión).
- Trabajo en servidor para lotes muy grandes. `runBatch` ya es isomorfo (no toca el DOM),
  así que correría allá sin reescribirlo: falta quién lo llame y dónde guarde el progreso.
- Limitador de cuota respaldado en base de datos: el de balde vive en memoria del proceso
  y en serverless cada instancia tiene el suyo.
- Bias por IP server-side cuando no hay `center` configurado.
- Caché de geocodificaciones en backend (legal con proveedores OSM).
- Publicación como paquetes npm privados cuando haya un segundo consumidor real
  (el primero será la encuesta de estudio-movilidad).
