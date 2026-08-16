# Ejemplos

## `external-system-demo.mts`

Demo end-to-end de un **sistema externo** hablando con
`@allride/geo-batch-api` por HTTP de verdad — no por import directo, como
haría un ERP o un sistema de nóminas ajeno a este monorepo. Corre solo, sin
proveedor de geocoding real ni clave de LocationIQ (usa un `GeoClient` de
mentira con dos direcciones fijas), y ejercita en un solo recorrido los 9
pasos del paquete:

```
crear el trabajo → el worker lo procesa → llega el webhook `batch.done`
→ se detecta una fila incierta → se emite un link firmado → alguien SIN
clave de API la corrige por ese link → llega el webhook
`batch.row_corrected` → se borra el trabajo
```

```bash
npm run example -w @allride/geo-batch-api
# o, parado en packages/geo-batch-api:
npx tsx examples/external-system-demo.mts
```

No modifica nada fuera de su propio proceso: store en memoria y dos
servidores HTTP en puertos efímeros (el de la API y el que hace de
"receptor de webhooks" del sistema externo), todo se cierra solo al
terminar. Sirve como referencia para integrar de verdad — cada llamada usa
`fetch` con el mismo contrato que vería un cliente en otro lenguaje — y
como humo end-to-end rápido (corre en menos de un segundo) para confirmar
que el worker, los webhooks, los links de corrección y la retención siguen
encajando entre sí después de tocar cualquiera de esas piezas.
