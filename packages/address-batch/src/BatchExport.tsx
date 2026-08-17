import { useState } from "react";
import {
  toClipboardText,
  toDelimited,
  toExportTable,
  type BatchResultRow,
} from "@allride/geo-core";
import { fill, type BatchTexts } from "./texts.ts";
import { buildWorkbookBlob } from "./xlsx-io.ts";

/**
 * Exportación del lote: Excel, CSV y portapapeles.
 *
 * Los tres salen de la misma tabla (`toExportTable`), así que no hay forma
 * de que el Excel y el CSV digan cosas distintas — que es exactamente lo
 * que pasa cuando cada formato se arma por su cuenta.
 *
 * Las columnas originales del archivo vuelven intactas y las filas fallidas
 * aparecen marcadas en vez de desaparecer: una planilla a la que le faltan
 * doce filas se cruza mal y nadie nota lo que falta.
 */

export interface ExportFormatOptions {
  /**
   * Separador del CSV. `;` por defecto: Excel en configuración regional
   * española abre los `.csv` esperando punto y coma, y con coma mete todo
   * en la primera columna — quien recibe el archivo cree que se exportó mal.
   */
  csvDelimiter?: "," | ";";
  /**
   * Separador decimal de las coordenadas en CSV y portapapeles. Con `,` un
   * Excel en español las lee como números y no como texto.
   *
   * No afecta al `.xlsx`, donde las coordenadas van como número de verdad y
   * el separador lo pone Excel según la configuración de quien abra.
   */
  decimalSeparator?: "." | ",";
  /** Base del nombre de archivo, sin extensión. */
  fileName?: string;
}

export interface BatchExportProps {
  /** Todo el lote. */
  results: BatchResultRow[];
  /** Lo que hay a la vista tras filtrar y buscar. */
  filtered: BatchResultRow[];
  sourceHeaders: string[] | null;
  texts: BatchTexts;
  format?: ExportFormatOptions;
}

/** Coordenadas: las únicas columnas que deben ser numéricas en la planilla. */
const NUMERIC_HEADERS = ["Latitud", "Longitud"];

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BatchExport({ results, filtered, sourceHeaders, texts, format }: BatchExportProps) {
  const [onlyFiltered, setOnlyFiltered] = useState(false);
  const [busy, setBusy] = useState<"xlsx" | "csv" | "clip" | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const filtering = filtered.length !== results.length;
  const rows = onlyFiltered && filtering ? filtered : results;
  const base = `${format?.fileName ?? "direcciones-geocodificadas"}-${today()}`;

  function tableFor(decimalSeparator: "." | ",") {
    return toExportTable(rows, { sourceHeaders, decimalSeparator });
  }

  async function exportXlsx() {
    setBusy("xlsx");
    setNotice(null);
    try {
      // Punto decimal al armar la tabla: se convierte a número igual, y así
      // no depende de cómo esté configurado el CSV.
      const blob = await buildWorkbookBlob(tableFor("."), {
        sheetName: "Direcciones",
        numericHeaders: NUMERIC_HEADERS,
      });
      download(blob, `${base}.xlsx`);
    } catch {
      setNotice({ kind: "error", text: texts.exportFailed });
    } finally {
      setBusy(null);
    }
  }

  function exportCsv() {
    setBusy("csv");
    setNotice(null);
    try {
      const text = toDelimited(tableFor(format?.decimalSeparator ?? ","), {
        delimiter: format?.csvDelimiter ?? ";",
        // BOM siempre: sin él Excel abre el archivo en su codificación
        // local y "Peñalolén" llega como "PeÃ±alolÃ©n".
        bom: true,
      });
      download(new Blob([text], { type: "text/csv;charset=utf-8" }), `${base}.csv`);
    } catch {
      setNotice({ kind: "error", text: texts.exportFailed });
    } finally {
      setBusy(null);
    }
  }

  async function copyToClipboard() {
    setBusy("clip");
    setNotice(null);
    try {
      const text = toClipboardText(rows, {
        sourceHeaders,
        decimalSeparator: format?.decimalSeparator ?? ",",
      });
      await navigator.clipboard.writeText(text);
      setNotice({ kind: "ok", text: texts.exportClipboardDone });
    } catch {
      // El portapapeles falla por permisos o por contexto no seguro, y no
      // hay nada que la persona pueda hacer al respecto: se la manda al
      // camino que sí funciona.
      setNotice({ kind: "error", text: texts.exportClipboardFailed });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="arb-export">
      <div className="arb-toolbar">
        <button
          type="button"
          className="arb-button arb-button-primary"
          disabled={busy !== null}
          onClick={() => void exportXlsx()}
        >
          {busy === "xlsx" ? texts.exportBusy : texts.exportXlsx}
        </button>
        <button type="button" className="arb-button" disabled={busy !== null} onClick={exportCsv}>
          {texts.exportCsv}
        </button>
        <button
          type="button"
          className="arb-button"
          disabled={busy !== null}
          onClick={() => void copyToClipboard()}
        >
          {texts.exportClipboard}
        </button>
      </div>

      {filtering && (
        <label className="arb-check">
          <input
            type="checkbox"
            checked={onlyFiltered}
            onChange={() => setOnlyFiltered((v) => !v)}
          />
          <span>
            {filtered.length === 1
              ? texts.exportFilteredOnlyOne
              : fill(texts.exportFilteredOnly, { n: filtered.length })}
          </span>
        </label>
      )}

      {notice && (
        <p className={`arb-notice ${notice.kind === "error" ? "arb-notice-error" : ""}`} role="status">
          {notice.text}
        </p>
      )}
    </div>
  );
}
