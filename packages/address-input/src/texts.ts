/** Todos los textos visibles, sobreescribibles vía prop `texts`. */
export interface Texts {
  searchPlaceholder: string;
  searching: string;
  noSuggestions: string;
  forceSearchHint: string;
  forceSearchButton: string;
  noneMatches: string;
  adminAreaPlaceholder: string;
  adminAreaRequiredHint: string;
  privacyHint: string;
  belowMinPrecision: string;
  clearInput: string;
  centerOnMe: string;
  centeringOnMe: string;
  notFound: string;
  networkError: string;
  useGps: string;
  gpsDenied: string;
  gpsUnavailable: string;
  gpsBlocked: string;
  gpsNoPosition: string;
  gpsTimeout: string;
  gpsCurrentLocation: string;
  pickOnMap: string;
  pickOnMapPlaceholder: string;
  enterCoords: string;
  coordsPlaceholder: string;
  coordsHelp: string;
  coordsSubmit: string;
  coordsInvalid: string;
  coordsOutOfRange: string;
  coordsSwapped: string;
  coordsFar: string;
  resolving: string;
  matchedStreet: string;
  matchedZone: string;
  confirmQuestion: string;
  confirmMapFailed: string;
  reverseBusy: string;
  mapFailed: string;
  farWarning: string;
  back: string;
  confirm: string;
  confirmAnyway: string;
  edit: string;
}

export const DEFAULT_TEXTS: Texts = {
  searchPlaceholder: "Escribe una dirección o lugar…",
  searching: "Buscando sugerencias…",
  noSuggestions: "No encontramos coincidencias con lo que escribiste.",
  forceSearchHint: "¿No aparece lo que buscas?",
  /**
   * "Buscar de todas formas" no comunicaba nada nuevo: la persona ya está
   * buscando. Este texto nombra lo que la acción realmente hace distinto —
   * buscar el texto completo tal como se escribió, en vez de las
   * sugerencias parciales del autocompletado.
   */
  forceSearchButton: "Buscar la dirección tal como la escribí",
  noneMatches: "¿Ninguna coincide con lo que escribiste?",
  adminAreaPlaceholder: "Escribe y elige de la lista",
  adminAreaRequiredHint: "Elige primero la comuna para buscar tu dirección.",
  privacyHint:
    "Si prefieres no dar tu dirección exacta, puedes indicar una esquina o un punto cercano.",
  belowMinPrecision:
    "El punto quedó a nivel de zona. Si puedes, acércalo a la dirección exacta antes de confirmar.",
  clearInput: "Borrar lo escrito",
  centerOnMe: "Centrar en mi ubicación",
  centeringOnMe: "Ubicando…",
  notFound:
    "No encontramos esa dirección. Revisa la escritura, o usa \"Marcar en el mapa\" para ubicarla directamente.",
  networkError: "No pudimos buscar la dirección (¿sin conexión?). Intenta de nuevo o marca en el mapa.",
  useGps: "Usar mi ubicación",
  gpsDenied: "No pudimos acceder a tu ubicación. Escribe la dirección o marca en el mapa.",
  gpsUnavailable: "Tu navegador no permite usar la ubicación. Escribe la dirección o marca en el mapa.",
  // Los tres motivos de falla del GPS piden acciones distintas: uno se
  // arregla en la configuración del navegador, otro solo con reintentar,
  // el tercero moviendo el pin a mano.
  gpsBlocked:
    "Tu navegador tiene bloqueado el acceso a tu ubicación. Actívalo en los permisos del sitio (el ícono a la izquierda de la dirección web) o mueve el pin a mano.",
  gpsNoPosition: "No pudimos determinar tu ubicación. Mueve el pin a mano o intenta de nuevo.",
  gpsTimeout: "Tu ubicación está tardando demasiado. Intenta de nuevo o mueve el pin a mano.",
  gpsCurrentLocation: "Tu ubicación actual",
  pickOnMap: "Marcar en el mapa",
  pickOnMapPlaceholder: "Ubica el punto en el mapa",
  enterCoords: "Ingresar coordenadas",
  coordsPlaceholder: "-33.4489, -70.6693",
  coordsHelp: "Acepta decimales (lat, lng), grados 33°26'56\"S y enlaces de Google Maps.",
  coordsSubmit: "Usar coordenadas",
  coordsInvalid: "No pudimos interpretar esas coordenadas. Revisa el formato.",
  coordsOutOfRange: "Esas coordenadas están fuera de rango (lat ±90, lng ±180).",
  coordsSwapped: "Interpretamos el orden como longitud, latitud y lo corregimos — revisa el pin.",
  coordsFar: "El punto queda lejos de la zona esperada — revisa el pin en el mapa.",
  resolving: "Buscando…",
  matchedStreet: "Encontramos la calle pero no el número exacto — acerca el pin a la entrada si puedes.",
  matchedZone: "No encontramos la dirección exacta — el pin quedó en el centro de la zona. Arrástralo hasta el punto correcto.",
  confirmQuestion: "¿Es correcto el punto? Toca el mapa para mover el pin, o arrástralo para un ajuste fino.",
  confirmMapFailed: "Revisa que la dirección de arriba sea correcta antes de confirmar.",
  reverseBusy: "Actualizando dirección…",
  mapFailed:
    "No pudimos cargar el mapa visual (puede ser tu conexión). No hay problema — igual puedes confirmar con la dirección de abajo.",
  farWarning: "El punto quedó muy lejos de la zona esperada. ¿Seguro que es correcto?",
  back: "Volver",
  confirm: "Confirmar",
  confirmAnyway: "Confirmar de todas formas",
  edit: "Editar",
};
