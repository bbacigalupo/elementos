import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import {
  parseInputText,
  templateTable,
  toDelimited,
  type BatchProgress,
  type BatchStopReason,
  type ColumnRole,
  type QuotaStatus,
  type TileConfig,
  type TileThemeName,
} from "@allride/geo-core";
import { BatchResults } from "./BatchResults.tsx";
import { BatchExport, type ExportFormatOptions } from "./BatchExport.tsx";
import { DEFAULT_BATCH_TEXTS, fill, humanDuration, type BatchTexts } from "./texts.ts";
import { useBatchGeocode, type BatchGeocodeConfig } from "./useBatchGeocode.ts";
import { snapshotResultsForExport } from "./snapshot.ts";
import {
  buildWorkbookBlob,
  isSpreadsheet,
  readWorkbook,
  XlsxUnavailableError,
  type WorkbookSheet,
} from "./xlsx-io.ts";

/**
 * <AddressBatch> — UI de referencia del elemento de geocodificación masiva,
 * sobre el hook headless `useBatchGeocode`.
 *
 * Estilos en styles.css (prefijo .arb-), personalizables con variables CSS.
 */

/** Roles ofrecidos en el mapeo, en el orden en que tiene sentido leerlos. */
const ROLE_OPTIONS: Array<{ value: ColumnRole; label: string }> = [
  { value: "ignore", label: "No usar (se conserva)" },
  { value: "address", label: "Dirección completa" },
  { value: "street", label: "Calle" },
  { value: "number", label: "Número" },
  { value: "district", label: "Comuna / distrito" },
  { value: "city", label: "Ciudad" },
  { value: "region", label: "Región" },
  { value: "postalCode", label: "Código postal" },
  { value: "country", label: "País" },
  { value: "label", label: "Nombre / identificador" },
  { value: "unit", label: "Depto / oficina" },
];

export interface AddressBatchProps extends BatchGeocodeConfig {
  texts?: Partial<BatchTexts>;
  className?: string;
  /** Apariencia del mapa de resultados, o `false` para no ofrecerlo. */
  map?: { theme?: TileThemeName; tiles?: TileConfig } | false;
  /**
   * Tope de filas que se leen de un archivo, antes de aplicar `maxRows`.
   * Es un freno a la lectura: una planilla con un millón de filas usadas
   * por accidente cuelga la pestaña antes de que nadie vea un mensaje.
   */
  readLimit?: number;
  /** Formatos de salida, o `false` para no ofrecer exportación. */
  export?: ExportFormatOptions | false;
  /** Reemplaza por completo la fase de resultados. */
  renderResults?: (batch: ReturnType<typeof useBatchGeocode>) => ReactNode;
}

function download(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function AddressBatch({
  texts: textsOverride,
  className,
  map,
  readLimit,
  export: exportable,
  renderResults,
  ...config
}: AddressBatchProps) {
  const batch = useBatchGeocode(config);
  const texts: BatchTexts = { ...DEFAULT_BATCH_TEXTS, ...textsOverride };
  const textareaId = useId();
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  /** Hojas de un libro con más de una: hay que elegir cuál se usa. */
  const [sheets, setSheets] = useState<{ fileName: string; list: WorkbookSheet[] } | null>(null);
  const [truncated, setTruncated] = useState(0);
  const [loadOpen, setLoadOpen] = useState(false);

  const { phase, stats } = batch;
  const hasAddress =
    batch.parsed.kind !== "table" || batch.mapping.some((r) => r === "address" || r === "street");
  const canStart = stats.total > 0 && hasAddress;
  const resumableExportRows = useMemo(
    () => (batch.resumable ? snapshotResultsForExport(batch.resumable) : null),
    [batch.resumable],
  );

  function useSheet(fileName: string, sheet: WorkbookSheet) {
    setTruncated(sheet.truncatedRows);
    setSheets(null);
    batch.loadTable({
      headers: sheet.table.headers,
      rows: sheet.table.rows,
      fileName: `${fileName} · ${sheet.name}`,
    });
  }

  async function readFile(file: File) {
    setFileError(null);
    setTruncated(0);
    setSheets(null);
    setReading(true);
    try {
      if (isSpreadsheet(file.name)) {
        const found = await readWorkbook(file, { maxRows: readLimit });
        if (found.length === 0) {
          setFileError(texts.fileEmpty);
        } else if (found.length === 1) {
          useSheet(file.name, found[0]);
          setLoadOpen(false);
        } else {
          setLoadOpen(false);
          // Varias hojas con datos: elegir por el software cuál es "la
          // buena" es justo la decisión que no le corresponde.
          setSheets({ fileName: file.name, list: found });
        }
        return;
      }

      const content = await file.text();
      const parsed = parseInputText(content, { assume: file.name.endsWith(".csv") ? "table" : undefined });
      if (parsed.kind === "table") {
        batch.loadTable({ headers: parsed.headers, rows: parsed.rows, fileName: file.name });
      } else {
        batch.clearLoaded();
        batch.setText(parsed.lines.join("\n"));
      }
      setLoadOpen(false);
    } catch (err) {
      setFileError(err instanceof XlsxUnavailableError ? texts.xlsxUnavailable : texts.fileError);
    } finally {
      setReading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void readFile(file);
  }

  async function downloadTemplate(variant: "libre" | "estructurada") {
    const table = templateTable(variant);
    const base = `plantilla-direcciones-${variant}`;
    try {
      // Excel primero: la plantilla es para que alguien la llene, y el
      // formato que abre sin preguntar nada sobre separadores ni
      // codificación es el .xlsx.
      download(await buildWorkbookBlob(table, "Direcciones"), `${base}.xlsx`);
    } catch {
      // Sin la librería de planillas, un CSV con punto y coma y BOM sigue
      // abriéndose bien en Excel; es peor no poder descargar nada.
      download(
        new Blob([toDelimited(table, { delimiter: ";", bom: true })], {
          type: "text/csv;charset=utf-8",
        }),
        `${base}.csv`,
      );
    }
  }

  if (phase === "running") {
    return (
      <div className={`arb-root ${className ?? ""}`}>
        <RunningPanel batch={batch} texts={texts} />
      </div>
    );
  }

  if (phase === "review") {
    return (
      <div className={`arb-root ${className ?? ""}`}>
        <ReviewHeadline batch={batch} texts={texts} />
        {batch.stopReason ? (
          <StopReasonNotice reason={batch.stopReason} pending={batch.summary.pending} texts={texts} />
        ) : (
          batch.cancelled && <p className="arb-notice arb-notice-warn">{texts.cancelledNotice}</p>
        )}
        {renderResults ? (
          renderResults(batch)
        ) : (
          <BatchResults
            batch={batch}
            texts={textsOverride}
            map={map}
            export={exportable}
            renderActions={() => (
              <div className="arb-actions">
                <button type="button" className="arb-button arb-button-ghost" onClick={batch.backToInput}>
                  {texts.back}
                </button>
                <button type="button" className="arb-button arb-button-ghost" onClick={batch.reset}>
                  {texts.startOver}
                </button>
              </div>
            )}
          />
        )}
      </div>
    );
  }

  return (
    <div className={`arb-root ${className ?? ""}`}>
      {batch.resumable && (
        <section className="arb-panel arb-resume">
          <h3 className="arb-panel-title">{texts.resumeTitle}</h3>
          <p className="arb-help">
            {fill(texts.resumeHelp, {
              fecha: batch.resumable.savedAt.toLocaleString(),
              done: batch.resumable.done,
              total: batch.resumable.total,
            })}
          </p>
          <div className="arb-actions">
            <button type="button" className="arb-button arb-button-primary" onClick={batch.resume}>
              {texts.resumeAction}
            </button>
            <button
              type="button"
              className="arb-button arb-button-ghost"
              onClick={batch.discardResumable}
            >
              {texts.resumeDiscard}
            </button>
          </div>

          {exportable !== false && batch.resumable.done > 0 && resumableExportRows && (
            <div className="arb-resume-export">
              <p className="arb-help">{texts.resumeExportHint}</p>
              <BatchExport
                results={resumableExportRows}
                filtered={resumableExportRows}
                sourceHeaders={batch.resumable.sourceHeaders}
                texts={texts}
                format={exportable}
              />
            </div>
          )}
        </section>
      )}

      <div
        className={`arb-dropzone ${dragging ? "arb-dropzone-active" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label className="arb-label" htmlFor={textareaId}>
          {texts.inputLabel}
        </label>
        <p className="arb-help">{texts.inputHelp}</p>

        {batch.loaded ? (
          <div className="arb-file">
            <span>{fill(texts.loadedFile, { name: batch.loaded.fileName ?? "" })}</span>
            <button type="button" className="arb-button arb-button-ghost" onClick={batch.clearLoaded}>
              {texts.removeFile}
            </button>
          </div>
        ) : (
          <textarea
            id={textareaId}
            className="arb-textarea"
            value={batch.text}
            onChange={(e) => batch.setText(e.target.value)}
            placeholder={texts.placeholder}
            rows={8}
            spellCheck={false}
          />
        )}

        <div className="arb-toolbar">
          {/* Una sola entrada. Tres botones sueltos ocupaban dos líneas y no
              alcanzaban a explicar en qué se diferencian las plantillas; el
              diálogo tiene espacio para decirlo y ocupa cero mientras está
              cerrado. */}
          <button
            type="button"
            className="arb-button arb-button-ghost"
            disabled={reading}
            onClick={() => setLoadOpen(true)}
          >
            {reading ? texts.readingFile : texts.loadFile}
          </button>
        </div>
      </div>

      {loadOpen && (
        <LoadDialog
          texts={texts}
          reading={reading}
          onPick={(file) => void readFile(file)}
          onTemplate={(variant) => void downloadTemplate(variant)}
          onClose={() => setLoadOpen(false)}
        />
      )}

      {fileError && <p className="arb-notice arb-notice-error">{fileError}</p>}

      {sheets && (
        <section className="arb-panel">
          <h3 className="arb-panel-title">{texts.pickSheet}</h3>
          <p className="arb-help">{fill(texts.pickSheetHelp, { file: sheets.fileName })}</p>
          <div className="arb-toolbar">
            {sheets.list.map((sheet) => (
              <button
                key={sheet.name}
                type="button"
                className="arb-button arb-button-ghost"
                onClick={() => useSheet(sheets.fileName, sheet)}
              >
                {fill(texts.sheetOption, { name: sheet.name, n: sheet.table.rows.length })}
              </button>
            ))}
          </div>
        </section>
      )}

      {truncated > 0 && (
        <p className="arb-notice arb-notice-warn">{fill(texts.fileTruncated, { n: truncated })}</p>
      )}

      {phase === "mapping" && (
        <ColumnMapping batch={batch} texts={texts} hasAddress={hasAddress} />
      )}

      <div className="arb-status">
        <strong>
          {stats.total === 1 ? texts.countOne : fill(texts.countMany, { n: stats.total })}
        </strong>
        {config.maxRows != null && (
          <span className="arb-muted">{fill(texts.limitHint, { max: config.maxRows })}</span>
        )}
      </div>

      {stats.droppedOverLimit > 0 && (
        <p className="arb-notice arb-notice-warn">
          {fill(texts.overLimit, { n: stats.droppedOverLimit, max: config.maxRows ?? "" })}
        </p>
      )}
      {stats.duplicates > 0 && (
        <p className="arb-notice">{fill(texts.duplicatesHint, { n: stats.duplicates })}</p>
      )}
      {batch.reusable > 0 && (
        <p className="arb-notice">{fill(texts.reusableHint, { n: batch.reusable })}</p>
      )}
      {stats.emptyRows > 0 && (
        <p className="arb-notice">{fill(texts.emptyRowsHint, { n: stats.emptyRows })}</p>
      )}
      <QuotaPreflightNotice
        needed={Math.max(0, stats.queries - batch.reusable)}
        status={batch.quotaStatus}
        texts={texts}
      />

      <div className="arb-actions">
        <button
          type="button"
          className="arb-button arb-button-primary"
          onClick={batch.start}
          disabled={!canStart}
        >
          {stats.total > 0 ? fill(texts.start, { n: stats.total }) : texts.startEmpty}
        </button>
        {/* La estimación va antes de empezar, no después: es lo que permite
            decidir si esperar ahora o cargar menos filas. */}
        {canStart && batch.estimateMs > 5000 && (
          <span className="arb-muted">
            {fill(texts.estimate, { time: humanDuration(batch.estimateMs) })}
          </span>
        )}
      </div>
    </div>
  );
}

function ColumnMapping({
  batch,
  texts,
  hasAddress,
}: {
  batch: ReturnType<typeof useBatchGeocode>;
  texts: BatchTexts;
  hasAddress: boolean;
}) {
  return (
    <section className="arb-panel">
      <h3 className="arb-panel-title">{texts.mappingTitle}</h3>
      <p className="arb-help">{texts.mappingHelp}</p>

      <div className="arb-mapping">
        {batch.columnLabels.map((label, index) => (
          <label key={index} className="arb-mapping-item">
            <span className="arb-mapping-name">{label}</span>
            <select
              className="arb-select"
              value={batch.mapping[index] ?? "ignore"}
              onChange={(e) => {
                const next = [...batch.mapping];
                next[index] = e.target.value as ColumnRole;
                batch.setMapping(next);
              }}
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {!hasAddress && <p className="arb-notice arb-notice-error">{texts.mappingNoAddress}</p>}

      {batch.preview.length > 0 && (
        <div className="arb-preview">
          <h4 className="arb-preview-title">{texts.previewTitle}</h4>
          <div className="arb-table-scroll">
            <table className="arb-table">
              <thead>
                <tr>
                  {batch.columnLabels.map((label, i) => (
                    <th key={i}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {batch.preview.map((row, i) => (
                  <tr key={i}>
                    {batch.columnLabels.map((_, col) => (
                      <td key={col}>{row[col] ?? ""}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Pantalla de proceso. Reemplaza a la de entrada en vez de superponerse:
 * un overlay sobre campos todavía enfocables deja al teclado navegar a
 * controles que no deberían responder, y basta una tecla para alterar el
 * lote a mitad de camino.
 */
function RunningPanel({
  batch,
  texts,
}: {
  batch: ReturnType<typeof useBatchGeocode>;
  texts: BatchTexts;
}) {
  const { progress, recent } = batch;
  const done = progress?.done ?? 0;
  const total = progress?.total ?? batch.stats.total;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  const [stopping, setStopping] = useState(false);

  /*
   * Un lote de varios minutos significa que la persona se va a otra
   * pestaña. El porcentaje en el título es lo más barato que existe para
   * que pueda seguirlo desde ahí, y se restaura al terminar.
   */
  useEffect(() => {
    const original = document.title;
    document.title = fill(texts.tabProgress, { percent });
    return () => {
      document.title = original;
    };
  }, [percent, texts.tabProgress]);

  return (
    <section className="arb-panel arb-running" aria-busy="true">
      <h3 className="arb-panel-title">{texts.runningTitle}</h3>

      <ProgressBar progress={progress} total={total} percent={percent} label={texts.runningTitle} />

      <div className="arb-progress-meta">
        <strong>{fill(texts.progressOf, { done, total })}</strong>
        <span className="arb-muted">{percent}%</span>
        {progress?.etaMs != null && !progress.paused && (
          <span className="arb-muted">{fill(texts.remaining, { time: humanDuration(progress.etaMs) })}</span>
        )}
        {(progress?.saved ?? 0) > 0 && (
          <span className="arb-chip arb-chip-ok">{fill(texts.savedQueries, { n: progress!.saved })}</span>
        )}
      </div>

      {progress?.paused ? (
        <PausedNotice until={progress.pausedUntil} texts={texts} />
      ) : (
        progress?.current && <p className="arb-current" title={progress.current}>{progress.current}</p>
      )}

      <div className="arb-counters">
        <span className="arb-chip arb-chip-ok">{texts.statusOk}: {progress?.ok ?? 0}</span>
        <span className="arb-chip arb-chip-uncertain">{texts.statusUncertain}: {progress?.uncertain ?? 0}</span>
        <span className="arb-chip arb-chip-failed">{texts.statusFailed}: {progress?.failed ?? 0}</span>
      </div>

      {/* Ver direcciones reales apareciendo es lo que comunica avance de
          verdad; la barra sola es una abstracción que se mira una vez. */}
      {recent.length > 0 && (
        <div className="arb-live">
          <h4 className="arb-live-title">{texts.liveTitle}</h4>
          <ul className="arb-live-list">
            {recent.map((r) => (
              <li key={r.row.id} className={`arb-live-item arb-live-${r.status}`}>
                <span className="arb-live-index">{r.row.index}</span>
                <span className="arb-live-text" title={r.row.raw}>{r.row.raw}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <RotatingTip tips={texts.tips} />

      <p className="arb-help">{texts.runningHelp}</p>

      <div className="arb-actions">
        <button
          type="button"
          className="arb-button arb-button-ghost"
          disabled={stopping}
          onClick={() => {
            setStopping(true);
            batch.cancel();
          }}
        >
          {stopping ? texts.cancelling : texts.cancel}
        </button>
      </div>
    </section>
  );
}

/**
 * Barra segmentada por estado.
 *
 * Se llena con las proporciones reales de exitosas, inciertas y fallidas
 * en vez de un solo color. Informa mientras avanza —se ve venir si el lote
 * viene torcido— y cambia todo el tiempo, que es lo que hace que valga la
 * pena mirarla.
 */
function ProgressBar({
  progress,
  total,
  percent,
  label,
}: {
  progress: BatchProgress | null;
  total: number;
  percent: number;
  label: string;
}) {
  const parte = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div
      className={`arb-progress ${progress?.paused ? "arb-progress-paused" : ""}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={progress?.done ?? 0}
      aria-label={label}
      aria-valuetext={`${percent}%`}
    >
      <div className="arb-progress-bar arb-progress-ok" style={{ width: `${parte(progress?.ok ?? 0)}%` }} />
      <div
        className="arb-progress-bar arb-progress-uncertain"
        style={{ width: `${parte(progress?.uncertain ?? 0)}%` }}
      />
      <div
        className="arb-progress-bar arb-progress-failed"
        style={{ width: `${parte(progress?.failed ?? 0)}%` }}
      />
    </div>
  );
}

/** Pausa por cuota, con cuenta regresiva: esperar mirando un reloj se hace
 * bastante más corto que esperar mirando nada. */
function PausedNotice({ until, texts }: { until: number | null; texts: BatchTexts }) {
  const [restante, setRestante] = useState(() => segundosHasta(until));

  useEffect(() => {
    setRestante(segundosHasta(until));
    if (until === null) return;
    const timer = window.setInterval(() => setRestante(segundosHasta(until)), 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  return (
    <p className="arb-notice arb-notice-warn" role="status">
      {texts.paused}
      {restante > 0 && ` ${fill(texts.pausedCountdown, { s: restante })}`}
    </p>
  );
}

function segundosHasta(until: number | null): number {
  return until === null ? 0 : Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/**
 * Aviso antes de arrancar, cuando el lote pide más consultas de las que
 * quedan hoy.
 *
 * Es un aviso, no un bloqueo: el motor de todos modos se detiene solo y
 * deja lo pendiente listo para retomar (ver `StopReasonNotice`), así que
 * impedir el arranque no protegería nada — solo informa antes, que es
 * mejor que enterarse a mitad de camino.
 */
function QuotaPreflightNotice({
  needed,
  status,
  texts,
}: {
  needed: number;
  status: QuotaStatus | null;
  texts: BatchTexts;
}) {
  if (!status?.configured || status.remaining == null || needed <= status.remaining) return null;
  return (
    <p className="arb-notice arb-notice-warn">
      {fill(texts.quotaPreflight, { needed, remaining: status.remaining })}
    </p>
  );
}

/**
 * Por qué el lote se detuvo antes de terminar, cuando no fue la persona
 * quien lo canceló.
 *
 * Reemplaza al aviso genérico de cancelación: "el proceso se detuvo" no
 * dice si hay que revisar las direcciones, avisarle a alguien, o solo
 * esperar — y esa distinción es exactamente lo que cada motivo aporta.
 */
function StopReasonNotice({
  reason,
  pending,
  texts,
}: {
  reason: BatchStopReason;
  pending: number;
  texts: BatchTexts;
}) {
  const texto =
    reason === "quota"
      ? fill(texts.quotaExhausted, { pending })
      : reason === "auth"
        ? texts.authError
        : texts.serviceDown;
  return (
    <p className="arb-notice arb-notice-warn" role="status">
      {texto}
    </p>
  );
}

/**
 * Tip rotativo durante la espera.
 *
 * Cada tip explica algo que la persona va a poder usar apenas termine el
 * lote, así que el rato de espera deja de ser tiempo perdido. Rotan lento
 * —ocho segundos— porque un texto que cambia rápido distrae en vez de
 * acompañar.
 */
function RotatingTip({ tips }: { tips: string[] }) {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (tips.length < 2) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % tips.length), 8000);
    return () => window.clearInterval(timer);
  }, [tips.length]);

  if (tips.length === 0) return null;
  return (
    <p className="arb-tip" key={index}>
      <span aria-hidden="true">💡</span> {tips[index]}
    </p>
  );
}

/**
 * Encabezado de los resultados.
 *
 * Se lee antes que la tabla y dice cuánto trabajo queda, no cuántas filas
 * hay: "241 listas, 9 necesitan tu revisión" convierte un muro de
 * doscientas cincuenta filas en una tarea de nueve. Cuando no queda nada
 * por revisar, lo dice y ya.
 */
function ReviewHeadline({
  batch,
  texts,
}: {
  batch: ReturnType<typeof useBatchGeocode>;
  texts: BatchTexts;
}) {
  const { summary } = batch;
  const listas = summary.ok + summary.corrected;
  const trabajo = summary.uncertain + summary.failed;

  /*
   * Aviso del sistema al terminar, solo si el permiso ya estaba dado. No se
   * pide nunca: pedir permiso de notificaciones a alguien que solo quería
   * geocodificar una planilla es exactamente el patrón que la gente
   * aprendió a rechazar por reflejo.
   */
  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    new Notification(fill(texts.doneNotification, { total: summary.total }));
  }, [summary.total, texts.doneNotification]);

  return (
    <p className="arb-headline">
      {trabajo === 0
        ? fill(texts.reviewHeadlineClean, { ok: listas, total: summary.total })
        : trabajo === 1
          ? fill(texts.reviewHeadlineWorkOne, { ok: listas })
          : fill(texts.reviewHeadlineWork, { ok: listas, work: trabajo })}
    </p>
  );
}

/**
 * Diálogo de carga desde archivo.
 *
 * Reemplaza a tres botones sueltos que ocupaban dos líneas de la pantalla
 * principal y no explicaban nada: "Plantilla simple" y "Plantilla separada"
 * no dicen cuál corresponde a tu caso. Acá cada una viene con la pregunta
 * que de verdad se está haciendo quien las mira —"¿cuándo uso esta?"— y
 * mientras el diálogo está cerrado no ocupa espacio alguno.
 */
function LoadDialog({
  texts,
  reading,
  onPick,
  onTemplate,
  onClose,
}: {
  texts: BatchTexts;
  reading: boolean;
  onPick: (file: File) => void;
  onTemplate: (variant: "libre" | "estructurada") => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog?.isConnected && !dialog.open) dialog.showModal();
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="arb-dialog arb-dialog-load"
      aria-labelledby="arb-load-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <div className="arb-dialog-body">
        <div className="arb-dialog-head">
          <h3 className="arb-panel-title" id="arb-load-title">
            {texts.loadDialogTitle}
          </h3>
          <button
            type="button"
            className="arb-dialog-close"
            aria-label={texts.cancelCorrection}
            onClick={() => dialogRef.current?.close()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <p className="arb-help">{texts.loadDialogIntro}</p>

        <div
          className={`arb-drop-target ${dragging ? "arb-drop-target-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file) onPick(file);
          }}
        >
          <p className="arb-drop-title">{texts.loadDropzone}</p>
          <button
            type="button"
            className="arb-button arb-button-primary"
            disabled={reading}
            onClick={() => inputRef.current?.click()}
          >
            {reading ? texts.readingFile : texts.loadPick}
          </button>
          <p className="arb-muted">{texts.loadFormats}</p>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.xlsm,.xlsb,.xls,.ods,text/csv,text/plain"
            className="arb-file-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onPick(file);
              event.target.value = "";
            }}
          />
        </div>

        <section className="arb-templates">
          <h4 className="arb-templates-title">{texts.templatesTitle}</h4>
          <ul className="arb-template-list">
            <li>
              <button
                type="button"
                className="arb-button arb-button-ghost"
                onClick={() => onTemplate("libre")}
              >
                {texts.templateFree}
              </button>
              <span className="arb-muted">{texts.templateFreeWhen}</span>
            </li>
            <li>
              <button
                type="button"
                className="arb-button arb-button-ghost"
                onClick={() => onTemplate("estructurada")}
              >
                {texts.templateStructured}
              </button>
              <span className="arb-muted">{texts.templateStructuredWhen}</span>
            </li>
          </ul>
        </section>
      </div>
    </dialog>
  );
}
