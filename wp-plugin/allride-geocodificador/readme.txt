=== AllRide Geocodificador ===
Contributors: allride
Tags: geocoding, direcciones, gps, coordenadas
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.1.0
License: UNLICENSED

Convierte muchas direcciones a coordenadas GPS a la vez, separando lo que se
puede usar de lo que hay que revisar.

== Description ==

Reemplaza a la versión anterior del geocodificador de AllRide (sobre
Nominatim, tope de 100 direcciones, reporte solo OK/Err). Esta versión
clasifica cada resultado en exitoso, incierto o fallido en vez de marcar
todo "OK" cuando el proveedor encontró la calle pero no la altura exacta.

Inserta el shortcode `[allride_geocodificador]` en cualquier página o
entrada. Antes hay que configurar la URL del backend en
Ajustes → AllRide Geocodificador — el plugin no geocodifica nada por sí
solo, solo aloja la interfaz y habla con ese backend (que sí tiene la
clave del proveedor de direcciones).

== Installation ==

1. Sube la carpeta `allride-geocodificador` a `/wp-content/plugins/`, o
   sube el .zip desde Plugins → Añadir nuevo → Subir plugin.
2. Activa el plugin.
3. Ve a Ajustes → AllRide Geocodificador y completa la URL del backend.
4. Inserta `[allride_geocodificador]` en la página donde quieras la
   herramienta.

== Changelog ==

= 1.1.1 =
* Corregido: el mapa mostraba "API KEY REQUIRED" en vez del mapa de fondo.
  CARTO cortó el acceso gratuito sin clave a sus mapas; se reemplazó por
  Esri (gratis, sin clave), sin cambios visibles más allá de eso.

= 1.1.0 =
* El país ya no viene fijo: selector obligatorio en la herramienta, sin
  default (evita degradar en silencio direcciones de fuera de Chile).
  Ajustes ya no tiene campo de país por defecto — dejó de aplicar.
* Corregido: el modal de corrección se abría pegado a la esquina, no
  centrado (lo rompía el reset de CSS del tema de WordPress).
* "Empezar de nuevo" ahora pide confirmación antes de borrar el lote.
* Ajustes muestra la versión instalada, para reportar errores más fácil.

= 1.0.0 =
Primera versión sobre el nuevo motor (@allride/address-batch).
