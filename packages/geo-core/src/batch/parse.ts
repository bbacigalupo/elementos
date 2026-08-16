import type { GeoBias, LocationValue } from "../types.ts";
import { normalizeTokens } from "../relevance.ts";
import { parseCoordinates } from "../coords.ts";
import { canonicalAdminArea } from "../admin/index.ts";
import { cleanQuery, STREET_TYPES } from "./clean.ts";

export { streetTokens } from "./clean.ts";

/**
 * Entrada de un lote de direcciones. Cubre las tres formas de ingresar
 * datos que se piden al elemento masivo:
 *
 * - **Escribir texto**, una dirección por línea.
 * - **Pegar celdas de Excel**, que llegan al portapapeles como texto
 *   separado por tabulaciones (y con comillas cuando una celda contiene
 *   saltos de línea o el propio separador).
 * - **Cargar un CSV**, que es lo mismo con coma o punto y coma.
 *
 * Las tres terminan en la misma estructura, así que el resto del sistema
 * —motor de lote, clasificación, exportación— no sabe de dónde vino el
 * dato. El XLSX no se lee acá: eso vive en el paquete de UI, que convierte
 * la planilla a filas y entra por `buildRows`.
 */

/** Campos de una dirección cuando vienen separados en columnas. */
export interface AddressFields {
  street?: string;
  number?: string;
  /** Depto, oficina, block. No se manda al geocoder: no aporta al punto. */
  unit?: string;
  /** Comuna, municipio, distrito — la división administrativa fina. */
  district?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO-3166-1 alpha-2 o nombre; solo se usa si no hay país en el bias. */
  country?: string;
}

/**
 * Qué representa cada columna de la tabla pegada o cargada.
 *
 * `address` es la dirección completa en una sola celda; los demás son
 * campos sueltos. `label` conserva un identificador de la fila (nombre del
 * colaborador, código interno) para poder devolverlo en la exportación.
 * `ignore` no participa de la búsqueda pero **igual se preserva** al
 * exportar: quien carga una nómina espera recuperar sus columnas.
 */
export type ColumnRole = "ignore" | "address" | "label" | keyof AddressFields;

export interface BatchInputRow {
  /** Estable dentro del lote; sirve como key de React y para retomar. */
  id: string;
  /** Número de fila tal como lo ve la persona (1-based). */
  index: number;
  /** Lo que ingresó, tal cual, para mostrar y para exportar. */
  raw: string;
  /** El texto que se le manda al geocoder. */
  query: string;
  /**
   * División administrativa declarada. Viaja aparte, nunca concatenada al
   * query: los geocoders resuelven bastante mejor "calle + número" cuando
   * la comuna va en su propio campo (lección del elemento individual).
   */
  adminArea?: { name: string; parentName?: string };
  fields?: AddressFields;
  /** Celdas originales de la fila, en el orden de `sourceHeaders`. */
  cells?: string[];
  /**
   * Id de la primera fila con la misma dirección. Las duplicadas no se
   * geocodifican de nuevo: copian el resultado de la original. En una
   * nómina real de una empresa esto solo puede ahorrar consultas —varias
   * personas viven en la misma dirección— y el ahorro es directo en cuota.
   */
  duplicateOf?: string;
}

export interface ParsedTable {
  kind: "table";
  delimiter: "\t" | "," | ";";
  /** null cuando la primera fila ya son datos. */
  headers: string[] | null;
  rows: string[][];
}

export interface ParsedLines {
  kind: "lines";
  lines: string[];
}

export type ParsedInput = ParsedTable | ParsedLines;

// ---------- lectura de texto delimitado ----------

/** Excel y varios exportadores anteponen BOM; sin quitarlo el primer
 * encabezado nunca calza con nada. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Lector de texto delimitado con comillas (RFC 4180).
 *
 * No alcanza con `split("\n")` y `split(delim)`: al copiar celdas de Excel,
 * una celda con una dirección en dos líneas o con una coma llega entre
 * comillas, y partir a lo bruto rompe esa fila y desalinea todas las
 * columnas siguientes.
 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        // Comilla doble dentro de comillas = comilla literal.
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // \r\n cuenta como un solo fin de fila.
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.map((r) => r.map((cell) => cell.trim()));
}

/**
 * Elige el separador contando ocurrencias fuera de comillas.
 *
 * El tabulador gana si aparece: es lo que produce pegar celdas de Excel, y
 * una dirección con comas ("Av. Providencia 1234, Providencia") no debe
 * confundirse con dos columnas solo porque tiene comas.
 */
function detectDelimiter(text: string): "\t" | "," | ";" | null {
  const counts: Record<string, number> = { "\t": 0, ",": 0, ";": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char in counts) counts[char] += 1;
  }
  if (counts["\t"] > 0) return "\t";
  if (counts[";"] > counts[","]) return ";";
  if (counts[","] > 0) return ",";
  return null;
}

/** Encabezados conocidos, por rol. Se comparan normalizados (sin tildes). */
const HEADER_ALIASES: Array<[ColumnRole, string[]]> = [
  ["address", ["direccion", "direcciones", "address", "domicilio", "direccion completa"]],
  ["street", ["calle", "street", "via", "avenida", "nombre calle", "nombre de calle"]],
  ["number", ["numero", "nro", "num", "altura", "number", "no"]],
  ["unit", ["depto", "departamento", "oficina", "unit", "block", "casa"]],
  ["district", ["comuna", "distrito", "municipio", "delegacion", "alcaldia", "district", "barrio"]],
  ["city", ["ciudad", "city", "localidad", "poblacion"]],
  ["region", ["region", "estado", "provincia", "departamento", "state"]],
  ["postalCode", ["codigo postal", "cp", "postal", "zip", "postal code"]],
  ["country", ["pais", "country"]],
  ["label", ["nombre", "name", "id", "codigo", "rut", "identificador", "etiqueta", "colaborador"]],
];

function normalizeHeader(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function roleForHeader(header: string): ColumnRole | null {
  const key = normalizeHeader(header);
  if (!key) return null;
  for (const [role, aliases] of HEADER_ALIASES) {
    if (aliases.includes(key)) return role;
  }
  return null;
}

/**
 * Deduce qué es cada columna a partir de los encabezados. Lo que no se
 * reconoce queda en `ignore` — visible en la UI para que la persona lo
 * corrija, y preservado en la exportación de todos modos.
 *
 * `region` y `departamento` chocan entre países (en Chile "departamento" es
 * un depto habitacional; en Perú o Colombia es una división
 * administrativa). Se resuelve por posición: si ya hay una columna de
 * unidad, el segundo "departamento" es la división.
 */
export function guessMapping(headers: string[]): ColumnRole[] {
  const used = new Set<ColumnRole>();
  return headers.map((header) => {
    const role = roleForHeader(header);
    if (!role) return "ignore";
    // Una sola columna por rol: la segunda "ciudad" se ignora en vez de
    // pisar a la primera en silencio.
    if (role !== "ignore" && used.has(role)) return "ignore";
    used.add(role);
    return role;
  });
}

/** ¿La primera fila son encabezados o ya son datos? */
function looksLikeHeaderRow(cells: string[]): boolean {
  const recognized = cells.filter((c) => roleForHeader(c) !== null).length;
  if (recognized >= 2) return true;
  // Con una sola columna reconocida, exigir además que ninguna celda
  // parezca una dirección: "Dirección" es encabezado, "Dirección 123" no.
  if (recognized === 1) return !cells.some((c) => /\d/.test(c));
  return false;
}

/**
 * Arma una tabla a partir de filas ya separadas en celdas.
 *
 * Es el camino de entrada de quien lee un XLSX: la librería de planillas
 * entrega `string[][]` y de ahí en adelante todo —relleno de filas cortas,
 * detección de encabezados, mapeo de columnas— es exactamente el mismo
 * código que para un pegado o un CSV. Sin esto, cada formato de archivo
 * traería su propia idea de qué es un encabezado.
 */
export function tableFromRows(
  rows: string[][],
  opts: { hasHeader?: boolean } = {},
): ParsedTable {
  const clean = rows
    .map((r) => r.map((cell) => (cell ?? "").trim()))
    .filter((r) => r.some((c) => c !== ""));
  if (clean.length === 0) return { kind: "table", delimiter: "\t", headers: null, rows: [] };

  const width = Math.max(...clean.map((r) => r.length));
  const padded = clean.map((r) =>
    r.length === width ? r : [...r, ...Array(width - r.length).fill("")],
  );
  const hasHeader = opts.hasHeader ?? (padded.length > 1 && looksLikeHeaderRow(padded[0]));

  return {
    kind: "table",
    delimiter: "\t",
    headers: hasHeader ? padded[0] : null,
    rows: hasHeader ? padded.slice(1) : padded,
  };
}

export interface ParseInputOptions {
  /**
   * Fuerza la interpretación cuando el contexto la conoce: al cargar un
   * archivo `.csv` sabemos que es una tabla aunque no traiga encabezados,
   * cosa que al pegar texto no se puede saber.
   */
  assume?: "lines" | "table";
}

/**
 * Interpreta un pegado o el contenido de un archivo de texto.
 *
 * El criterio para decidir entre tabla y lista de líneas no es simétrico
 * entre separadores, y no puede serlo:
 *
 * - **Tabulador**: siempre tabla. Es lo que produce copiar celdas de Excel
 *   y nadie escribe direcciones con tabuladores.
 * - **Punto y coma**: tabla. Es el CSV de Excel en configuración regional
 *   española, y tampoco aparece dentro de una dirección.
 * - **Coma**: solo si hay encabezados reconocibles. `Av. Providencia 1234,
 *   Providencia, Santiago` es una dirección, no tres columnas — y ese es
 *   justamente el formato que se le pide a la gente que escriba.
 *
 * Una sola columna vuelve a ser una lista de líneas: no tiene sentido
 * hacer pasar a alguien por un mapeo de columnas para mapear una.
 */
export function parseInputText(text: string, opts: ParseInputOptions = {}): ParsedInput {
  const clean = stripBom(text).replace(/\s+$/, "");
  if (!clean.trim()) return { kind: "lines", lines: [] };

  const delimiter = detectDelimiter(clean);
  if (delimiter && opts.assume !== "lines") {
    const rows = parseDelimited(clean, delimiter).filter((r) => r.some((c) => c !== ""));
    const width = Math.max(...rows.map((r) => r.length));
    const commaNeedsHeader =
      delimiter === "," && opts.assume !== "table" && !(rows.length > 1 && looksLikeHeaderRow(rows[0]));
    if (width > 1 && !commaNeedsHeader) {
      // Filas cortas se rellenan y se detecta el encabezado con el mismo
      // criterio que para un XLSX: `tableFromRows`.
      return { ...tableFromRows(rows), delimiter };
    }
    // No es tabla. Se rearman las líneas con su separador: la coma es parte
    // de la dirección, quedarse con la primera celda perdería la comuna.
    return { kind: "lines", lines: linesOf(rows.map((r) => r.join(delimiter === "\t" ? "\t" : `${delimiter} `))) };
  }

  return { kind: "lines", lines: linesOf(clean.split(/\r?\n/)) };
}

function linesOf(lines: string[]): string[] {
  return lines
    .map((l) => l.trim())
    .map((l) =>
      // Un CSV de una sola columna llega con la dirección entera entre
      // comillas; dejarlas la mandaría al geocoder tal cual.
      l.length > 1 && l.startsWith('"') && l.endsWith('"') ? l.slice(1, -1).replace(/""/g, '"').trim() : l,
    )
    .filter((l) => l !== "");
}

// ---------- armado de filas ----------

export interface BuildRowsOptions {
  /**
   * Rol de cada columna, solo para tablas. Si se omite se deduce de los
   * encabezados; sin encabezados, la primera columna se toma como
   * dirección completa.
   */
  mapping?: ColumnRole[];
  /**
   * Tope de filas a procesar. Es parámetro del consumidor a propósito: una
   * herramienta pública y anónima necesita un límite bajo, una interna con
   * usuarios autenticados no tiene por qué tenerlo. Sin valor, no hay tope.
   */
  maxRows?: number;
  /** Marcar filas repetidas para no gastar una consulta por cada una. */
  dedupe?: boolean;
  /**
   * Datos que aplican a todo el lote (las "opciones generales": país,
   * región, ciudad). Completan lo que la fila no trae; nunca lo pisan.
   */
  defaults?: AddressFields;
}

export interface BuildRowsResult {
  rows: BatchInputRow[];
  /** Encabezados originales, para reconstruir el archivo al exportar. */
  sourceHeaders: string[] | null;
  /** Filas descartadas por quedar sin nada que buscar. */
  emptyRows: number;
  /** Filas recortadas por `maxRows`. */
  droppedOverLimit: number;
  /** Filas que repiten una dirección anterior. */
  duplicates: number;
}

/**
 * Arma el texto de búsqueda a partir de campos sueltos.
 *
 * La división administrativa fina (comuna) se deja fuera a propósito: sale
 * por `adminArea`, como dato estructurado. Pegarla al texto degrada los
 * resultados —LocationIQ llegó a devolver otra calle con el mismo número—
 * y esa es justamente la lección cara del elemento individual.
 *
 * `unit` tampoco entra: el depto no mueve el punto. Aun así el texto pasa
 * por `cleanQuery`, porque la columna "Número" llega llena de "N° 4501" y
 * ese prefijo sí mueve el punto — kilómetros.
 */
export function composeQuery(fields: AddressFields, defaults?: AddressFields): string {
  const merged: AddressFields = { ...defaults, ...stripEmpty(fields) };
  const line1 = [merged.street, merged.number].filter(Boolean).join(" ");
  const rest = [merged.city, merged.region].filter(Boolean);
  return cleanQuery([line1 || null, ...rest].filter(Boolean).join(", ")).query;
}

function stripEmpty(fields: AddressFields): AddressFields {
  const out: AddressFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const trimmed = typeof value === "string" ? value.trim() : value;
    if (trimmed) out[key as keyof AddressFields] = trimmed as string;
  }
  return out;
}

function adminAreaOf(fields: AddressFields, defaults?: AddressFields): BatchInputRow["adminArea"] {
  const merged: AddressFields = { ...defaults, ...stripEmpty(fields) };
  const name = merged.district;
  if (!name) return undefined;
  return merged.region ? { name, parentName: merged.region } : { name };
}

/**
 * Clave de deduplicación de direcciones.
 *
 * Ignora capitalización, tildes, espaciado, puntuación **y el tipo de vía**.
 * Esto último importa más de lo que parece en una nómina que llenó cada
 * persona por su cuenta: "Av. Providencia 1234", "Avenida Providencia
 * 1234" y "Providencia 1234" son la misma dirección, y sin normalizar el
 * tipo de vía costaban tres consultas en vez de una.
 *
 * El número SÍ cuenta: "Los Leones 220" y "Los Leones 240" son distintas.
 */
export function addressKey(row: { query: string; adminArea?: { name: string } }): string {
  const texto = normalizeTokens(row.query)
    .filter((t) => !STREET_TYPES.has(t))
    .join(" ");
  const area = normalizeTokens(row.adminArea?.name ?? "")
    .filter((t) => !STREET_TYPES.has(t))
    .join(" ");
  return `${texto}|${area}`;
}

function finalize(rows: BatchInputRow[], opts: BuildRowsOptions, sourceHeaders: string[] | null, emptyRows: number): BuildRowsResult {
  let droppedOverLimit = 0;
  let kept = rows;
  if (opts.maxRows != null && rows.length > opts.maxRows) {
    droppedOverLimit = rows.length - opts.maxRows;
    kept = rows.slice(0, opts.maxRows);
  }

  let duplicates = 0;
  if (opts.dedupe !== false) {
    const firstSeen = new Map<string, string>();
    for (const row of kept) {
      const key = addressKey(row);
      const original = firstSeen.get(key);
      if (original) {
        row.duplicateOf = original;
        duplicates += 1;
      } else {
        firstSeen.set(key, row.id);
      }
    }
  }

  return { rows: kept, sourceHeaders, emptyRows, droppedOverLimit, duplicates };
}

/**
 * Convierte lo interpretado en filas listas para geocodificar.
 *
 * Numera con el índice **original**, antes de descartar vacías: si la fila
 * 47 de la planilla falla, quien la revise tiene que poder ir a la fila 47
 * de su planilla, no a la 45.
 */
export function buildRows(input: ParsedInput, opts: BuildRowsOptions = {}): BuildRowsResult {
  const rows: BatchInputRow[] = [];
  let emptyRows = 0;

  if (input.kind === "lines") {
    input.lines.forEach((line, i) => {
      const raw = line.trim();
      if (!raw) {
        emptyRows += 1;
        return;
      }
      const merged = stripEmpty({ ...opts.defaults });
      const extra = [merged.city, merged.region].filter(Boolean).join(", ");
      // `raw` guarda lo que la persona escribió —es lo que ve en la tabla y
      // lo que recupera al exportar—; lo que viaja al proveedor va limpio.
      const base = cleanQuery(raw).query;
      rows.push({
        id: `r${i + 1}`,
        index: i + 1,
        raw,
        // Las opciones generales completan lo que la línea no dice. Si la
        // persona ya escribió la ciudad, repetirla no aporta y puede
        // confundir al geocoder, así que solo se agrega si falta.
        query: extra && !containsAll(base, extra) ? `${base}, ${extra}` : base,
        adminArea: merged.district ? adminAreaOf({}, merged) : undefined,
      });
    });
    return finalize(rows, opts, null, emptyRows);
  }

  const mapping =
    opts.mapping ??
    (input.headers ? guessMapping(input.headers) : defaultMappingForHeaderless(input.rows));

  input.rows.forEach((cells, i) => {
    const fields: AddressFields = {};
    let address = "";
    cells.forEach((cell, col) => {
      const role = mapping[col] ?? "ignore";
      const value = cell.trim();
      if (!value) return;
      if (role === "address") address = value;
      else if (role !== "ignore" && role !== "label") fields[role] = value;
    });

    const limpia = address ? cleanQuery(address).query : "";
    const composed = limpia || composeQuery(fields, opts.defaults);
    const merged = { ...stripEmpty({ ...opts.defaults }), ...stripEmpty(fields) };
    const extra = [merged.city, merged.region].filter(Boolean).join(", ");
    const query = limpia && extra && !containsAll(limpia, extra) ? `${limpia}, ${extra}` : composed;

    if (!query.trim()) {
      emptyRows += 1;
      return;
    }

    rows.push({
      id: `r${i + 1}`,
      index: i + 1,
      raw: address || composed,
      query,
      adminArea: adminAreaOf(fields, opts.defaults),
      fields: Object.keys(fields).length > 0 ? fields : undefined,
      cells,
    });
  });

  return finalize(rows, opts, input.headers, emptyRows);
}

/** ¿El texto ya contiene todos los tokens de este agregado? */
function containsAll(text: string, addition: string): boolean {
  const haystack = normalizeTokens(text);
  const needles = normalizeTokens(addition);
  return needles.length > 0 && needles.every((n) => haystack.includes(n));
}

/**
 * Sin encabezados hay que adivinar por contenido. La columna con más celdas
 * que parecen dirección (texto largo, con número) es la dirección; el resto
 * se ignora pero se conserva.
 */
function defaultMappingForHeaderless(rows: string[][]): ColumnRole[] {
  const width = Math.max(0, ...rows.map((r) => r.length));
  const scores = Array.from({ length: width }, (_, col) =>
    rows.reduce((acc, row) => {
      const cell = (row[col] ?? "").trim();
      return acc + (cell.length >= 8 && /\d/.test(cell) && /[a-zA-Z]/.test(cell) ? 1 : 0);
    }, 0),
  );
  const best = scores.indexOf(Math.max(...scores));
  return Array.from({ length: width }, (_, col) => (col === best && scores[best] > 0 ? "address" : "ignore"));
}

/** Bias del lote con el país de las opciones generales, si no vino ya puesto. */
export function biasForBatch(bias: GeoBias, defaults?: AddressFields): GeoBias {
  if (bias.country || !defaults?.country) return bias;
  const country = defaults.country.trim();
  return /^[a-zA-Z]{2}$/.test(country) ? { ...bias, country: country.toUpperCase() } : bias;
}

/**
 * ¿Esta fila ya trae coordenadas en vez de una dirección?
 *
 * Pasa más de lo que uno esperaría: quien arma la nómina pega un punto
 * sacado de Google Maps, o una columna que ya venía geocodificada de otro
 * sistema. Hasta acá esas filas se mandaban igual al geocoder — gastaban
 * una consulta y volvían fallidas, porque ningún buscador de direcciones
 * entiende "-33.4489, -70.6693".
 *
 * Resolverlas localmente cuesta cero consultas y da un resultado mejor:
 * quien escribe coordenadas está declarando un punto exacto a propósito,
 * y por eso la precisión es `exact`.
 */
export function coordinatesFromRow(
  row: BatchInputRow,
  bias?: GeoBias,
): LocationValue | null {
  const parsed = parseCoordinates(row.raw, bias);
  if (!parsed.ok) return null;

  return {
    lat: parsed.lat,
    lng: parsed.lng,
    // Sin dirección que mostrar: no se inventa una, y no se gasta una
    // consulta de reverse para adornarla. El punto es el dato.
    formatted: row.raw.trim(),
    components: {
      street: null, number: null, sublocality: null,
      // Lo único que se sabe de la dirección es lo que la planilla declaró.
      // No es mucho, pero es gratis y es lo que la persona espera recuperar
      // en su columna Comuna.
      commune: declaredCommune(row, bias?.country),
      city: null, region: null, postalCode: null,
      country: bias?.country ?? null,
    },
    precision: "exact",
    source: "coords",
    provider: "coordenadas ingresadas",
    capturedAt: new Date().toISOString(),
  };
}

/** La comuna declarada en la planilla, en la grafía del catálogo. */
function declaredCommune(row: BatchInputRow, country?: string | null): string | null {
  const declarada = row.adminArea?.name;
  if (!declarada) return null;
  return canonicalAdminArea(country, declarada) ?? declarada;
}
