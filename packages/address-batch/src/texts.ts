/** Todos los textos visibles, sobreescribibles vía prop `texts`. */
export interface BatchTexts {
  // entrada
  inputLabel: string;
  inputHelp: string;
  placeholder: string;
  countOne: string;
  countMany: string;
  limitHint: string;
  overLimit: string;
  duplicatesHint: string;
  emptyRowsHint: string;
  loadFile: string;
  loadDialogTitle: string;
  loadDialogIntro: string;
  loadDropzone: string;
  loadPick: string;
  loadFormats: string;
  templatesTitle: string;
  templateFreeWhen: string;
  templateStructuredWhen: string;
  readingFile: string;
  loadedFile: string;
  removeFile: string;
  fileError: string;
  fileEmpty: string;
  fileTruncated: string;
  xlsxUnavailable: string;
  pickSheet: string;
  pickSheetHelp: string;
  sheetOption: string;
  downloadTemplate: string;
  templateFree: string;
  templateStructured: string;

  // mapeo de columnas
  mappingTitle: string;
  mappingHelp: string;
  mappingNoAddress: string;
  previewTitle: string;

  // proceso
  start: string;
  startEmpty: string;
  estimate: string;
  runningTitle: string;
  runningHelp: string;
  progressOf: string;
  remaining: string;
  cancel: string;
  cancelling: string;
  paused: string;
  pausedCountdown: string;
  /** Aviso antes de arrancar, cuando el lote pide más consultas de las que quedan hoy. */
  quotaPreflight: string;
  /** El lote se detuvo a mitad de camino por cuota diaria agotada. */
  quotaExhausted: string;
  /** El proveedor rechazó la credencial configurada: no es un problema de las direcciones. */
  authError: string;
  /** El servicio de direcciones no está respondiendo. */
  serviceDown: string;
  liveTitle: string;
  tips: string[];
  savedQueries: string;
  reusableHint: string;
  tabProgress: string;
  doneNotification: string;
  reviewHeadlineClean: string;
  reviewHeadlineWork: string;
  reviewHeadlineWorkOne: string;
  resumeTitle: string;
  resumeHelp: string;
  resumeAction: string;
  resumeDiscard: string;
  resumeExportHint: string;

  // resultados
  reviewTitle: string;
  cancelledNotice: string;
  statusOk: string;
  statusUncertain: string;
  statusFailed: string;
  statusCorrected: string;
  statusPending: string;
  /** Los mismos estados en singular: en una fila, "Exitosas" no se lee. */
  rowOk: string;
  rowUncertain: string;
  rowFailed: string;
  rowCorrected: string;
  rowPending: string;
  back: string;
  startOver: string;

  // tabla
  filterAll: string;
  filterHint: string;
  searchPlaceholder: string;
  noRowsForFilter: string;
  clearFilters: string;
  showMore: string;
  colIndex: string;
  colLabel: string;
  colInput: string;
  colStatus: string;
  colReason: string;
  colLat: string;
  colLng: string;
  showMap: string;
  hideMap: string;
  mapLoading: string;
  viewOnMap: string;
  fixRow: string;
  correctingRow: string;
  cancelCorrection: string;
  correctionLabel: string;
  switchToSearch: string;
  reviewRow: string;
  searchRow: string;
  correctionHelp: string;
  correctionLoading: string;
  correctionDone: string;

  // página de corrección por link
  correctionLinkExpired: string;
  correctionLinkInvalid: string;
  correctionLinkNotFound: string;
  correctionLinkNetworkError: string;
  correctionLinkGenericError: string;
  correctionLinkRetry: string;
  correctionLinkDone: string;

  exportXlsx: string;
  exportCsv: string;
  exportClipboard: string;
  exportClipboardDone: string;
  exportClipboardFailed: string;
  exportFilteredOnly: string;
  exportFilteredOnlyOne: string;
  exportBusy: string;
  exportFailed: string;
  rowDetails: string;
  hideDetails: string;
  detailPrecision: string;
  detailProvider: string;
  detailComponents: string;
  detailQuery: string;
  detailDuplicate: string;
  precisionRooftop: string;
  precisionStreet: string;
  precisionZone: string;
  precisionExact: string;
}

export const DEFAULT_BATCH_TEXTS: BatchTexts = {
  inputLabel: "Direcciones",
  inputHelp:
    "Una dirección por línea. También puedes pegar celdas copiadas directamente de Excel.",
  placeholder:
    "Av. Providencia 1234, Providencia, Santiago\nAv. Grecia 3000, Ñuñoa, Santiago",
  countOne: "1 dirección",
  countMany: "{n} direcciones",
  limitHint: "Máximo {max}",
  // Decir cuántas quedaron fuera, no solo que se pasó del límite: quien
  // pegó 640 filas necesita saber que 140 no se procesaron. Se nombra que
  // el límite es de la herramienta gratuita — no un error ni un capricho —
  // y se deja la puerta abierta a ampliarlo.
  overLimit:
    "{n} direcciones quedaron fuera del límite de {max} de esta herramienta gratuita y no se procesarán. Para lotes más grandes u otras funciones premium, contáctanos: https://allrideapp.com/contacto/",
  duplicatesHint: "{n} repetidas: se consultan una sola vez y el resultado se copia.",
  emptyRowsHint: "{n} filas vacías se omitieron.",
  loadFile: "Cargar desde un archivo",
  loadDialogTitle: "Cargar desde un archivo",
  loadDialogIntro:
    "Arrastra tu planilla o elige el archivo. Detectamos las columnas solas y después puedes ajustarlas.",
  loadDropzone: "Arrastra el archivo aquí",
  loadPick: "Elegir archivo",
  loadFormats: "Excel (.xlsx, .xls) · CSV · texto separado por tabulaciones",
  templatesTitle: "¿No tienes la planilla armada?",
  // Cada plantilla dice CUÁNDO usarla, que es la pregunta real de quien
  // está mirando dos botones sin saber en qué se diferencian.
  templateFreeWhen:
    "Si cada persona escribió su dirección completa en una sola celda. Es lo más común.",
  templateStructuredWhen:
    "Si tienes la calle, el número y la comuna en columnas distintas. Da resultados algo mejores.",
  readingFile: "Leyendo el archivo…",
  loadedFile: "Archivo: {name}",
  removeFile: "Quitar archivo",
  fileError: "No pudimos leer ese archivo. Revisa que sea un CSV o un Excel válido.",
  fileEmpty: "El archivo no tiene ninguna hoja con datos.",
  fileTruncated:
    "El archivo es muy grande: se leyeron las primeras filas y {n} quedaron fuera. Divídelo en partes si necesitas procesarlas todas.",
  xlsxUnavailable:
    "No pudimos abrir archivos de Excel en este sitio. Guarda tu planilla como CSV y vuelve a intentar.",
  pickSheet: "¿Qué hoja quieres usar?",
  pickSheetHelp: "{file} tiene varias hojas con datos.",
  sheetOption: "{name} ({n} filas)",
  downloadTemplate: "Descargar plantilla",
  templateFree: "Plantilla simple",
  templateStructured: "Plantilla por columnas",

  mappingTitle: "¿Qué contiene cada columna?",
  mappingHelp:
    "Detectamos columnas en lo que ingresaste. Las que marques como no usadas igual vuelven en la exportación.",
  mappingNoAddress:
    "Marca al menos una columna como dirección completa, o como calle, para poder buscar.",
  previewTitle: "Primeras filas",

  start: "Geocodificar {n}",
  startEmpty: "Geocodificar direcciones",
  estimate: "Tomará alrededor de {time}.",
  runningTitle: "Geocodificando direcciones",
  // Explicar por qué está bloqueado, no solo bloquear: sin esto, una
  // pantalla que no responde se lee como que la herramienta se colgó.
  runningHelp:
    "Esto puede tomar varios minutos. No cierres esta pestaña: el proceso corre acá y se detiene si la cierras.",
  progressOf: "{done} de {total}",
  remaining: "Faltan {time}",
  cancel: "Detener",
  cancelling: "Deteniendo…",
  // Una barra detenida sin explicación se lee como que la herramienta se
  // colgó; decir que se está esperando convierte el susto en paciencia.
  paused: "En pausa: el servicio de direcciones pidió esperar. Se reanuda solo.",
  pausedCountdown: "Se reanuda en {s} s.",
  // Mismo encuadre que `overLimit`: el freno es del plan gratuito, no un
  // fallo, y hay a quién escribirle si hace falta más.
  quotaPreflight:
    "Este lote necesita unas {needed} consultas y hoy quedan {remaining} en esta herramienta gratuita. Puedes procesar una parte ahora; para ampliar la cuota u otras funciones premium, contáctanos: https://allrideapp.com/contacto/",
  // La reafirmación de que las direcciones no tienen la culpa es la parte
  // que más importa: sin ella, alguien revisa 300 filas buscando el error
  // que en realidad es nuestro, no suyo.
  quotaExhausted:
    "Se acabó la cuota diaria de esta herramienta gratuita. Quedaron {pending} direcciones sin procesar — no hay nada malo en ellas. Descarga lo ya resuelto y retómalas cuando la cuota se reponga, o contáctanos para ampliarla: https://allrideapp.com/contacto/",
  authError:
    "El servicio de direcciones rechazó la credencial configurada. No es un problema de tus direcciones: avisa a quien administra la herramienta. Lo ya procesado quedó guardado.",
  serviceDown:
    "El servicio de direcciones no está respondiendo. No es un problema de tus direcciones: lo ya procesado quedó guardado y podrás retomar el resto en unos minutos.",
  liveTitle: "Últimas resueltas",
  /*
   * Tips reales sobre esta herramienta, no relleno para llenar el silencio.
   * Cada uno explica algo que la persona va a poder usar en cuanto termine
   * el lote; si no aportara nada, sería mejor no mostrar ninguno.
   */
  tips: [
    "Las direcciones repetidas se consultan una sola vez: el resultado se copia al resto.",
    "Al terminar vas a poder corregir a mano las inciertas, con buscador y mapa.",
    "Agregar la comuna mejora bastante la precisión de la búsqueda.",
    "Las filas que ya traían coordenadas se resuelven al instante, sin consultar nada.",
    "Podrás ver todos los puntos juntos en un mapa para detectar los que quedaron fuera de zona.",
    "Las columnas que no se usan igual vuelven en el archivo que descargues.",
    "Si vuelves a procesar la misma lista, no se repiten las consultas ya hechas.",
  ],
  savedQueries: "{n} resueltas sin consultar",
  reusableHint: "{n} ya están resueltas de la corrida anterior: no se volverán a consultar.",
  tabProgress: "{percent}% · Geocodificando",
  doneNotification: "Listo: {total} direcciones procesadas.",
  reviewHeadlineClean: "Todo listo: {ok} de {total} sin problemas.",
  reviewHeadlineWork: "{ok} listas. {work} necesitan tu revisión.",
  reviewHeadlineWorkOne: "{ok} listas. 1 necesita tu revisión.",
  resumeTitle: "Tienes un lote a medias",
  resumeHelp: "Quedó guardado el {fecha}, con {done} de {total} direcciones resueltas. Retomarlo no vuelve a consultar lo ya hecho.",
  resumeAction: "Retomar el lote",
  resumeDiscard: "Descartarlo",
  resumeExportHint: "También puedes descargar lo ya resuelto sin retomar el lote:",

  reviewTitle: "Resultados",
  cancelledNotice:
    "El proceso se detuvo antes de terminar. Las direcciones sin procesar quedaron pendientes.",
  statusOk: "Exitosas",
  statusUncertain: "Inciertas",
  statusFailed: "Fallidas",
  statusCorrected: "Corregidas",
  statusPending: "Sin procesar",
  rowOk: "Exitosa",
  rowUncertain: "Incierta",
  rowFailed: "Fallida",
  rowCorrected: "Corregida",
  rowPending: "Sin procesar",
  back: "Volver a las direcciones",
  startOver: "Empezar de nuevo",

  filterAll: "Todas",
  // El resumen no es decorativo: cada número lleva a las filas que lo
  // componen, que es lo que alguien quiere hacer apenas lo lee.
  filterHint: "Toca un estado para ver solo esas filas.",
  searchPlaceholder: "Buscar en la tabla…",
  noRowsForFilter: "Ninguna fila coincide con el filtro.",
  clearFilters: "Quitar filtros",
  showMore: "Mostrar más",
  colIndex: "#",
  colLabel: "Identificador",
  colInput: "Dirección ingresada",
  colStatus: "Estado",
  colReason: "Motivo",
  colLat: "Latitud",
  colLng: "Longitud",
  showMap: "Ver puntos en el mapa",
  hideMap: "Ocultar mapa",
  mapLoading: "Cargando el mapa…",
  viewOnMap: "Ver",
  fixRow: "Corregir",
  correctingRow: "Corrigiendo la fila {index}",
  cancelCorrection: "Cancelar",
  correctionLabel: "Busca la dirección correcta",
  switchToSearch: "Buscar por texto",
  reviewRow: "Revisar",
  searchRow: "Buscar",
  correctionHelp:
    "Elige una sugerencia, o marca el punto en el mapa. El punto que confirmes reemplaza al que encontró el buscador.",
  correctionLoading: "Cargando el corrector…",
  correctionDone: "Corregida a mano",

  correctionLinkExpired: "Este link ya venció. Pide uno nuevo a quien te lo compartió.",
  correctionLinkInvalid: "Este link no es válido.",
  correctionLinkNotFound: "Esta dirección ya no está disponible.",
  correctionLinkNetworkError: "No se pudo conectar. Revisa tu conexión e intenta de nuevo.",
  correctionLinkGenericError: "Algo no funcionó. Intenta de nuevo en un momento.",
  correctionLinkRetry: "Reintentar",
  correctionLinkDone: "¡Listo! El punto quedó guardado.",

  exportXlsx: "Descargar Excel",
  exportCsv: "Descargar CSV",
  exportClipboard: "Copiar para pegar en Excel",
  exportClipboardDone: "¡Copiado! Pégalo en una planilla.",
  exportClipboardFailed:
    "Tu navegador no permitió copiar. Descarga el archivo en su lugar.",
  // Si hay un filtro puesto, hay que decir qué se lleva el archivo: creer
  // que se exportó todo y descubrir después que faltan filas es peor que
  // cualquier error visible.
  exportFilteredOnly: "Exportar solo las {n} filas filtradas",
  exportFilteredOnlyOne: "Exportar solo la fila filtrada",
  exportBusy: "Preparando…",
  exportFailed: "No pudimos generar el archivo.",
  rowDetails: "Detalle",
  hideDetails: "Ocultar",
  detailPrecision: "Precisión",
  detailProvider: "Proveedor",
  detailComponents: "Componentes",
  detailQuery: "Texto consultado",
  detailDuplicate: "Copiada de otra fila idéntica.",
  precisionRooftop: "Dirección exacta",
  precisionStreet: "Calle, sin altura",
  precisionZone: "Centro de zona",
  precisionExact: "Coordenadas ingresadas",
};

/** Reemplaza `{clave}` por su valor. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * Duración en palabras. Se redondea a propósito: prometer "3 min 42 s" en
 * un proceso que depende de la red de otro es precisión falsa, y quien
 * espera solo necesita saber si va a alcanzar a tomarse un café.
 */
export function humanDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${Math.max(1, seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}
