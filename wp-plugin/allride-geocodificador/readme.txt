=== AllRide Geocodificador ===
Contributors: allride
Tags: geocoding, direcciones, gps, coordenadas
Requires at least: 5.8
Tested up to: 6.7
Requires PHP: 7.4
Stable tag: 1.0.0
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

= 1.0.0 =
Primera versión sobre el nuevo motor (@allride/address-batch).
