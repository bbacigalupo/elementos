import { DEFAULT_ISSUE_TEXTS, type BatchResultRow, type BatchStatus, type IssueCode } from "./classify.ts";

/**
 * Salida del lote como tabla, y de ahí a CSV o al portapapeles.
 *
 * Vive en el núcleo y sin dependencias a propósito: el XLSX necesita una
 * librería pesada y se arma en el paquete de UI con carga diferida, pero
 * CSV y el pegado a Excel no deberían costar 800 KB de bundle ni obligar a
 * tener React para exportar desde un script de servidor.
 *
 * Regla de la exportación: **las columnas originales vuelven intactas**.
 * Quien carga una nómina con nombre, RUT y centro de costo espera recuperar
 * su planilla con las coordenadas al lado, no una tabla nueva que después
 * tiene que cruzar a mano.
 */

export interface ExportTable {
  headers: string[];
  rows: string[][];
}

export const DEFAULT_STATUS_TEXTS: Record<BatchStatus, string> = {
  ok: "Exitoso",
  uncertain: "Incierto",
  failed: "Fallido",
  corrected: "Corregido",
  pending: "Sin procesar",
};

export interface ExportOptions {
  /** Encabezados del archivo original, para anteponer sus columnas. */
  sourceHeaders?: string[] | null;
  /** Textos de estado y de motivo, si la interfaz usa los suyos. */
  statusTexts?: Partial<Record<BatchStatus, string>>;
  issueTexts?: Partial<Record<IssueCode, string>>;
  /** Decimales de las coordenadas. 6 ≈ 11 cm: más es ruido. */
  decimals?: number;
  /**
   * Separador decimal. Excel en configuración regional española lee
   * "-33.44" como texto y no como número: con `,` las coordenadas llegan
   * como números y se pueden usar en fórmulas.
   */
  decimalSeparator?: "." | ",";
}

const RESULT_HEADERS = [
  "Estado",
  "Motivo",
  "Latitud",
  "Longitud",
  "Precisión",
  "Dirección normalizada",
  "Calle",
  "Número",
  "Comuna",
  "Ciudad",
  "Región",
  "País",
  "Origen",
];

function coord(value: number | null | undefined, opts: ExportOptions): string {
  if (value == null) return "";
  const text = value.toFixed(opts.decimals ?? 6);
  return opts.decimalSeparator === "," ? text.replace(".", ",") : text;
}

/** Motivos de una fila, en texto legible y concatenados. */
export function issuesText(result: BatchResultRow, texts?: Partial<Record<IssueCode, string>>): string {
  return result.issues
    .map((issue) => {
      const base = texts?.[issue.code] ?? DEFAULT_ISSUE_TEXTS[issue.code];
      return issue.detail ? `${base} (${issue.detail})` : base;
    })
    .join(" ");
}

/**
 * Arma la tabla de salida. Las filas sin resultado igual aparecen: una
 * planilla a la que le faltan las 12 direcciones que fallaron es peor que
 * una con 12 filas vacías marcadas como fallidas — la primera se cruza mal
 * y nadie nota lo que falta.
 */
export function toExportTable(results: BatchResultRow[], opts: ExportOptions = {}): ExportTable {
  const source = opts.sourceHeaders ?? null;
  const headers = [
    "#",
    ...(source ?? []),
    ...(source ? [] : ["Dirección ingresada"]),
    ...RESULT_HEADERS,
  ];

  const rows = results.map((result) => {
    const value = result.value;
    const c = value?.components;
    return [
      String(result.row.index),
      ...(source ? padCells(result.row.cells ?? [], source.length) : [result.row.raw]),
      opts.statusTexts?.[result.status] ?? DEFAULT_STATUS_TEXTS[result.status],
      issuesText(result, opts.issueTexts),
      coord(value?.lat, opts),
      coord(value?.lng, opts),
      value?.precision ?? "",
      value?.formatted ?? "",
      c?.street ?? "",
      c?.number ?? "",
      c?.commune ?? "",
      c?.city ?? "",
      c?.region ?? "",
      c?.country ?? "",
      result.correctedAt ? "corregido a mano" : result.fromDuplicate ? "copiado de fila idéntica" : (value?.provider ?? ""),
    ];
  });

  return { headers, rows };
}

function padCells(cells: string[], width: number): string[] {
  return cells.length >= width ? cells.slice(0, width) : [...cells, ...Array(width - cells.length).fill("")];
}

function quote(field: string, delimiter: string): string {
  return field.includes(delimiter) || field.includes('"') || /[\n\r]/.test(field)
    ? `"${field.replace(/"/g, '""')}"`
    : field;
}

export interface DelimitedOptions {
  /**
   * Separador. Excel en español abre los `.csv` esperando `;`; con coma
   * mete todo en la primera columna y quien recibe el archivo cree que se
   * exportó mal.
   */
  delimiter?: "," | ";" | "\t";
  /**
   * Marca de orden de bytes. Sin ella Excel abre el archivo en su
   * codificación local y las tildes salen rotas — "Peñalolén" se convierte
   * en "PeÃ±alolÃ©n" y la comuna deja de servir para filtrar.
   */
  bom?: boolean;
}

export function toDelimited(table: ExportTable, opts: DelimitedOptions = {}): string {
  const delimiter = opts.delimiter ?? ",";
  const lines = [table.headers, ...table.rows].map((row) =>
    row.map((field) => quote(field ?? "", delimiter)).join(delimiter),
  );
  return (opts.bom ? "﻿" : "") + lines.join("\r\n");
}

/** CSV para descargar: con BOM, porque el destino es Excel. */
export function toCsv(results: BatchResultRow[], opts: ExportOptions & DelimitedOptions = {}): string {
  return toDelimited(toExportTable(results, opts), { bom: true, ...opts });
}

/**
 * Texto para el portapapeles, listo para pegar en una planilla.
 *
 * Separado por tabuladores y sin BOM: es lo que Excel y Google Sheets
 * entienden al pegar, y ahorra el viaje de descargar un archivo y abrirlo
 * para algo que se resuelve con Ctrl+V.
 */
export function toClipboardText(results: BatchResultRow[], opts: ExportOptions = {}): string {
  return toDelimited(toExportTable(results, opts), { delimiter: "\t", bom: false });
}

/**
 * Planilla de ejemplo para que quien la reciba sepa qué llenar.
 *
 * Con datos reales y no `Lorem ipsum`: una plantilla con direcciones que
 * de verdad geocodifican deja probar el flujo completo antes de arriesgar
 * la nómina de la empresa.
 */
export function templateTable(variant: "libre" | "estructurada"): ExportTable {
  if (variant === "libre") {
    return {
      headers: ["Nombre", "Dirección"],
      rows: [
        ["Ana Pérez", "Av. Providencia 1234, Providencia, Santiago"],
        ["Luis Rojas", "Av. Grecia 3000, Ñuñoa, Santiago"],
        ["Carla Díaz", "Av. Libertador Bernardo O'Higgins 1449, Santiago"],
      ],
    };
  }
  return {
    headers: ["Nombre", "Calle", "Número", "Comuna", "Ciudad", "Región"],
    rows: [
      ["Ana Pérez", "Av. Providencia", "1234", "Providencia", "Santiago", "Región Metropolitana"],
      ["Luis Rojas", "Av. Grecia", "1700", "Peñalolén", "Santiago", "Región Metropolitana"],
      ["Carla Díaz", "Av. Libertador Bernardo O'Higgins", "1449", "Santiago", "Santiago", "Región Metropolitana"],
    ],
  };
}
