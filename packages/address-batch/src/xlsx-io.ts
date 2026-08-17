import { tableFromRows, type ExportTable, type ParsedTable } from "@allride/geo-core";

/**
 * Lectura y escritura de planillas Excel.
 *
 * SheetJS pesa varios cientos de KB y solo hace falta si alguien carga o
 * descarga un `.xlsx`: se importa con `import()` dentro de cada función, no
 * en el encabezado del módulo. Quien pega direcciones y exporta CSV nunca
 * lo baja.
 *
 * **Sobre la versión**: el paquete `xlsx` de npm quedó congelado en 0.18.5,
 * que arrastra advisories de prototype pollution y ReDoS. SheetJS publica
 * las versiones corregidas en su propio registro
 * (`https://cdn.sheetjs.com/xlsx-<v>/xlsx-<v>.tgz`), y de ahí conviene
 * instalarlo — importa de verdad acá, porque este código parsea archivos
 * que sube gente de afuera.
 */

/** Una hoja del libro, ya normalizada a filas de texto. */
export interface WorkbookSheet {
  name: string;
  table: ParsedTable;
  /** Filas que se dejaron fuera por el tope de lectura. */
  truncatedRows: number;
}

export class XlsxUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("No se pudo cargar la librería de planillas (xlsx).", { cause });
    this.name = "XlsxUnavailableError";
  }
}

type SheetJs = typeof import("xlsx");

async function loadSheetJs(): Promise<SheetJs> {
  try {
    const mod = await import("xlsx");
    return ((mod as { default?: SheetJs }).default ?? mod) as SheetJs;
  } catch (err) {
    /*
     * `xlsx` es una dependencia opcional: quien no la instala igual puede
     * usar el elemento con texto y CSV, y merece un mensaje claro en vez de
     * un error de módulo no encontrado.
     *
     * El motivo real se registra igual. Convertir cualquier falla en "no
     * está instalada" manda a quien depure esto a revisar el package.json
     * cuando el problema puede ser otro —una configuración del bundler,
     * por ejemplo— y no deja ninguna pista de que fue otra cosa.
     */
    console.error("[address-batch] no se pudo cargar la librería de planillas:", err);
    throw new XlsxUnavailableError(err);
  }
}

export interface ReadWorkbookOptions {
  /**
   * Tope de filas de datos que se leen por hoja. No es el tope del lote
   * —ese se aplica después— sino un freno a la lectura misma: una planilla
   * con un millón de filas usadas por accidente cuelga la pestaña antes de
   * que nadie llegue a ver un mensaje.
   */
  maxRows?: number;
}

/**
 * Lee un archivo de planilla y devuelve sus hojas con contenido.
 *
 * Devuelve todas las hojas y no solo la primera: las nóminas reales suelen
 * traer varias ("Santiago", "Regiones", "Instrucciones") y adivinar cuál es
 * la buena es exactamente el tipo de decisión que no debería tomar el
 * software por su cuenta.
 */
export async function readWorkbook(
  file: File | ArrayBuffer,
  opts: ReadWorkbookOptions = {},
): Promise<WorkbookSheet[]> {
  const XLSX = await loadSheetJs();
  const data = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const maxRows = opts.maxRows ?? 50_000;

  const book = XLSX.read(data, { type: "array", dense: true });
  const sheets: WorkbookSheet[] = [];

  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];
    if (!sheet) continue;

    let truncatedRows = 0;
    const ref = sheet["!ref"];
    if (ref) {
      const range = XLSX.utils.decode_range(ref);
      const total = range.e.r - range.s.r + 1;
      if (total > maxRows) {
        truncatedRows = total - maxRows;
        range.e.r = range.s.r + maxRows - 1;
        sheet["!ref"] = XLSX.utils.encode_range(range);
      }
    }

    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
      // `raw: false` entrega el texto tal como se ve en Excel. Con `true`,
      // una altura escrita como número puede llegar como 1234.0 y un código
      // con ceros a la izquierda los pierde.
      raw: false,
    });
    if (rows.length === 0) continue;

    const table = tableFromRows(rows.map((r) => r.map((cell) => String(cell ?? ""))));
    if (table.rows.length === 0) continue;
    sheets.push({ name, table, truncatedRows });
  }

  return sheets;
}

/** ¿Este archivo lo tiene que abrir SheetJS o alcanza con leerlo como texto? */
export function isSpreadsheet(fileName: string): boolean {
  return /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(fileName);
}

export interface BuildWorkbookOptions {
  sheetName?: string;
  /**
   * Encabezados cuyas celdas deben quedar como número y no como texto.
   *
   * Importa más de lo que parece: una latitud guardada como texto no se
   * puede promediar, ordenar ni graficar, y Excel la marca con el
   * triangulito verde de "número almacenado como texto" en cada fila. Es
   * además la razón por la que el `.xlsx` no tiene el problema del
   * separador decimal que sí tiene el CSV: acá se guarda un número, no su
   * representación escrita.
   */
  numericHeaders?: string[];
}

/** Genera el `.xlsx` y lo entrega como Blob, sin descargarlo. */
export async function buildWorkbookBlob(
  table: ExportTable,
  options: BuildWorkbookOptions | string = {},
): Promise<Blob> {
  const opts: BuildWorkbookOptions = typeof options === "string" ? { sheetName: options } : options;
  const sheetName = opts.sheetName ?? "Direcciones";
  const numeric = new Set(
    (opts.numericHeaders ?? []).map((h) => table.headers.indexOf(h)).filter((i) => i >= 0),
  );

  const XLSX = await loadSheetJs();
  const body = table.rows.map((row) =>
    row.map((cell, i) => {
      if (!numeric.has(i) || cell === "") return cell;
      // La coma decimal se acepta acá porque la tabla puede venir armada
      // para CSV; en la planilla igual termina como número.
      const n = Number(cell.replace(",", "."));
      return Number.isFinite(n) ? n : cell;
    }),
  );
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...body]);

  // Ancho de columna aproximado por su contenido: sin esto Excel abre todo
  // en 8 caracteres y las direcciones se ven como "Av. Provi###".
  sheet["!cols"] = table.headers.map((header, i) => {
    const largest = table.rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), header.length);
    return { wch: Math.min(Math.max(largest + 2, 8), 50) };
  });
  // (Congelar la fila de encabezados sería útil en una nómina larga, pero
  // escribir paneles es exclusivo de la edición Pro de SheetJS.)

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  const out = XLSX.write(book, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([out], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
