# Integrar los elementos de dirección en tu web

AllRide ofrece dos widgets de dirección listos para embeber en cualquier sitio web,
sin importar con qué tecnología esté construido (WordPress, un sitio estático, una
app React, lo que sea). Se integran con dos líneas de HTML: un `<script>` y un
`<div>` con la configuración.

| Elemento | Qué hace | Clase del contenedor |
|---|---|---|
| **Captura individual** | Un campo de dirección con autocompletado, mapa de confirmación, GPS opcional y corrección manual. Pensado para un formulario (checkout, alta de cliente, solicitud de servicio). | `allride-address-input` |
| **Carga masiva** | Sube una planilla o pega texto con muchas direcciones, las geocodifica y separa las que sirven de las que hay que revisar a mano. | `allride-address-batch` |

Ambos comparten el mismo `<script>` — cargarlo una vez habilita los dos.

## 1. Requisito: una URL de backend

Ninguno de los dos widgets habla directo con el proveedor de geocoding (evita
exponer claves y da control de cuota/costo). Necesitas la URL de un backend que
implemente el contrato HTTP de AllRide (tres rutas: `autocomplete`, `geocode`,
`reverse`). Dos caminos:

- **AllRide te da una URL ya desplegada** (lo más simple: nosotros administramos
  la clave del proveedor, la cuota y el CORS para tu dominio). Pídela a tu
  contacto en AllRide — solo necesitamos saber desde qué dominio vas a llamarla,
  para autorizarlo.
- **Despliegas tu propio backend.** Si prefieres tu propia clave de proveedor y
  tu propio control de cuota, `@bbacigalupo/geo-core` expone `createGeoHandlers`
  (handlers `Request`/`Response` estándar, se montan en Vercel Edge Functions,
  Node/Express, o cualquier runtime moderno). Pide acceso al paquete si este es
  tu caso — no hace falta reescribir nada, es la misma pieza que ya corre en
  producción para el geocodificador público de AllRide.

En ambos casos, el resultado es una URL como `https://geo.allrideapp.com/api/geo`
que vas a usar como `apiBaseUrl` en la configuración de cada widget.

## 2. Cargar el script

```html
<link rel="stylesheet" href="https://TU-CDN/allride-address-batch.css" />
<script src="https://TU-CDN/allride-address-batch.js" defer></script>
```

Un solo archivo JS y uno CSS cubren ambos elementos (mapa, Excel, todo incluido).
Pide a tu contacto en AllRide la URL donde está publicado, o aloja tú mismo los
dos archivos si prefieres servirlos desde tu propia infraestructura — son
estáticos, sin build ni dependencias del lado del servidor.

El script escanea la página al cargar y monta un widget en cada elemento que
encuentre con las clases de la tabla de arriba. No hace falta llamar nada a
mano — **salvo que tu contenedor se agregue al DOM después de la carga inicial**
(por ejemplo, una app de una sola página que renderiza el formulario más tarde):
para ese caso, más abajo está el montaje manual.

## 3. Captura individual

```html
<div
  class="allride-address-input"
  data-config='{
    "apiBaseUrl": "https://geo.allrideapp.com/api/geo",
    "bias": { "country": "CL", "center": { "lat": -33.4489, "lng": -70.6693 }, "radiusKm": 40 },
    "label": "Dirección de entrega",
    "formFieldName": "direccion"
  }'
></div>
```

### Configuración (`data-config`)

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `apiBaseUrl` | string | Sí | URL del backend (paso 1). |
| `bias.country` | string (ISO-3166 alfa-2) | Sí | País donde opera tu aplicación — este elemento no trae selector de país, así que hay que fijarlo. |
| `bias.center`, `bias.radiusKm` | `{lat,lng}`, número | No | Acota la búsqueda a tu zona de operación (recomendado: mejora mucho la relevancia del autocompletado). |
| `modes` | `{search,map,gps,coords}` | No | Qué caminos de captura mostrar. Todos activos por omisión. |
| `label`, `helpText` | string | No | Texto del campo. |
| `map.theme` | uno de `carto-positron` \| `carto-positron-xl` \| `carto-voyager` \| `carto-dark` \| `osm` | No | Estilo del mapa de confirmación. `carto-positron` por omisión. |
| `formFieldName` | string | No | Si lo indicas, el widget crea un `<input type="hidden">` con ese `name` dentro del contenedor, para que un `<form>` nativo que lo envuelva lo envíe sin JavaScript propio (ver ejemplo abajo). |

### Recibir el resultado

**Opción A — formulario nativo, sin JavaScript.** Envuelve el contenedor en un
`<form>` y usa `formFieldName`: al confirmar el pin, el campo oculto se llena con
la dirección capturada en JSON, y viaja con el resto del formulario al enviarlo.

```html
<form action="/guardar-pedido" method="post">
  <div
    class="allride-address-input"
    data-config='{"apiBaseUrl":"https://geo.allrideapp.com/api/geo","bias":{"country":"CL"},"formFieldName":"direccion"}'
  ></div>
  <button type="submit">Continuar</button>
</form>
```

Tu backend recibe el campo `direccion` como un string JSON con esta forma:

```json
{
  "lat": -33.4290115,
  "lng": -70.6211027,
  "formatted": "Avenida Providencia 1234, Providencia, Región Metropolitana de Santiago, CL",
  "components": { "street": "Avenida Providencia", "number": "1234", "commune": "Providencia", "city": "Providencia", "region": "Región Metropolitana de Santiago", "postalCode": "7500000", "country": "CL" },
  "placeId": "node:567262571",
  "precision": "exact"
}
```

**Opción B — JavaScript.** Escucha el evento `allride:address-change` en el
contenedor (o en `document`, porque el evento burbujea):

```js
document.addEventListener("allride:address-change", (e) => {
  const value = e.detail; // el mismo objeto de arriba, o null si se borró
  console.log(value?.formatted, value?.lat, value?.lng);
});
```

Se dispara cada vez que la persona confirma (o borra) una dirección — sirve
igual de bien para guardar el valor en el estado de tu propia app (React, Vue,
lo que uses) sin depender del formulario nativo.

## 4. Carga masiva

```html
<div
  class="allride-address-batch"
  data-config='{
    "apiBaseUrl": "https://geo.allrideapp.com/api/geo",
    "maxRows": 200,
    "countryCodes": ["CL", "PE", "MX"]
  }'
></div>
```

### Configuración (`data-config`)

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `apiBaseUrl` | string | Sí | URL del backend (paso 1). |
| `countryCodes` | string[] (ISO-3166 alfa-2) | No | Acota la lista del selector de país. Sin este campo se ofrecen todos los países — el elemento **siempre** pide elegir país explícitamente, sin default, porque puede recibir gente de cualquier lugar. |
| `bias.center`, `bias.radiusKm` | `{lat,lng}`, número | No | Acota la búsqueda dentro del país elegido. |
| `maxRows` | número | No | Tope de direcciones por carga. Sin valor, sin tope — ajústalo según la cuota de tu backend. |
| `concurrency` | número | No | Consultas simultáneas al backend. 2 por omisión. |
| `minIntervalMs` | número | No | Ritmo mínimo entre consultas, en ms. Ajusta según el límite por segundo de tu proveedor. |

### Cómo llega el resultado

El widget hace todo el trabajo de revisión en pantalla: separa las direcciones
que se pueden usar de las que hay que revisar, y trae sus propios botones para
**exportar a Excel, CSV o copiar al portapapeles** — esa es la vía pensada para
que una persona se lleve el resultado.

Si además quieres enterarte por JavaScript de cuándo un lote termina (por
ejemplo, para mostrar tu propio aviso), escucha `allride:batch-complete` en el
contenedor:

```js
document.addEventListener("allride:batch-complete", (e) => {
  const { ok, uncertain, failed } = e.detail; // conteos, no las filas
  console.log(`${ok} listas, ${uncertain} a revisar, ${failed} fallidas`);
});
```

El evento trae solo el **resumen** (conteos), no las direcciones mismas — son
datos reales de personas y este evento queda visible en el DOM de tu página.
Si necesitas las filas completas por código en vez de que alguien las descargue
en pantalla (por ejemplo, para guardarlas directo en tu base de datos), esa es
otra integración: `@bbacigalupo/geo-batch-api`, una API asíncrona con autenticación
por clave, trabajos y webhooks — pídesela a tu contacto en AllRide si es tu caso.

## 5. Apariencia

Todo el estilo se ajusta con variables CSS — no hace falta tocar el JS:

```css
/* Captura individual */
.allride-address-input .ari-root {
  --ari-accent: #111827;       /* color de marca */
  --ari-radius: 8px;           /* esquinas */
  --ari-font: "Inter", sans-serif;
}

/* Carga masiva */
.allride-address-batch .arb-root {
  --arb-accent: #111827;
  --arb-radius: 8px;
}
```

El marcador del mapa (captura individual) es por defecto el pin de marca
AllRide; si prefieres uno propio, pídelo a tu contacto — es una opción del
componente (`map.marker`) que hoy no está expuesta en `data-config` porque
requiere pasar un ícono SVG.

## 6. Varias instancias, o contenido cargado después

Puedes poner más de un `<div class="allride-address-input">` (o `-batch`) en la
misma página — cada uno se monta por separado con su propia configuración.

Si tu contenedor se agrega al DOM **después** de que el script ya corrió (rutas
de una SPA, un modal que se abre más tarde, contenido inyectado por JS), el
escaneo automático no lo va a encontrar — móntalo a mano:

```js
window.AllrideAddressInput.mount(document.getElementById("mi-contenedor"), {
  apiBaseUrl: "https://geo.allrideapp.com/api/geo",
  bias: { country: "CL" },
});

window.AllrideAddressBatch.mount(document.getElementById("otro-contenedor"), {
  apiBaseUrl: "https://geo.allrideapp.com/api/geo",
});
```

Mismos campos que `data-config`, como objeto JavaScript en vez de JSON en un
atributo.

## 7. Preguntas frecuentes

**¿Necesito mi propia clave de LocationIQ / Google / etc.?** No si usas un
backend que te da AllRide — la clave vive del lado del servidor y nunca llega
a tu página. Si despliegas tu propio backend, sí necesitas la tuya.

**¿El widget guarda algo en el navegador de mis usuarios?** La captura
individual no guarda nada entre sesiones. La carga masiva sí puede retomar un
lote interrumpido dentro de la misma sesión del navegador si así lo configuras
(`storageKey`, no expuesto todavía en este embed — pídelo si lo necesitas).

**¿Cuánto pesa?** El bundle único (React, mapa, soporte de Excel, ambos
elementos) son ~950 KB sin comprimir / ~305 KB con gzip, cargado una sola vez
con `defer` — no bloquea el render de tu página.

**¿Funciona en móvil?** Sí, es responsivo y el GPS es siempre opt-in (nunca se
pide permiso de ubicación sin que la persona lo pida explícitamente).
