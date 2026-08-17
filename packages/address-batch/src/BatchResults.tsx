import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_ISSUE_TEXTS,
  normalizeTokens,
  type BatchResultRow,
  type BatchStatus,
  type IssueCode,
  type Precision,
  type TileConfig,
  type TileThemeName,
} from "@allride/geo-core";
import { BatchExport, type ExportFormatOptions } from "./BatchExport.tsx";
import { DEFAULT_BATCH_TEXTS, fill, type BatchTexts } from "./texts.ts";
import type { BatchGeocode } from "./useBatchGeocode.ts";

/**
 * Leaflet y su CSS viajan en un chunk aparte que solo se pide al abrir el
 * mapa. Quien integra el elemento para exportar coordenadas a Excel y nunca
 * mira el mapa no paga ese peso.
 */
const BatchMap = lazy(() => import("./BatchMap.tsx"));

/**
 * El corrector arrastra el elemento de captura individual completo. Se
 * carga solo cuando alguien decide corregir una fila: en un lote donde todo
 * salió bien, nunca.
 */
const RowCorrection = lazy(() => import("./RowCorrection.tsx"));

/**
 * Tabla de resultados del lote.
 *
 * El objetivo no es mostrar datos, es **dirigir la revisión**: lo exitoso no
 * hay que mirarlo, lo incierto sí y lo fallido hay que rehacerlo. Por eso el
 * resumen funciona como filtro (cada número lleva a sus filas) y cada fila
 * incierta explica en palabras qué le pasa, en vez de dejar a alguien
 * comparando coordenadas a ojo.
 */

/** Orden de revisión: primero lo que exige trabajo. */
const FILTER_ORDER: BatchStatus[] = ["failed", "uncertain", "corrected", "ok", "pending"];

const STATUS_CLASS: Record<BatchStatus, string> = {
  ok: "arb-chip-ok",
  uncertain: "arb-chip-uncertain",
  failed: "arb-chip-failed",
  corrected: "arb-chip-ok",
  pending: "",
};

/**
 * Cuántas filas se pintan de una vez. Sin tope, un lote interno de 5.000
 * direcciones son 5.000 filas en el DOM y la pestaña se congela justo
 * cuando terminó de procesar — el peor momento posible para trabarse.
 */
const PAGE_SIZE = 200;

export interface BatchResultsProps {
  batch: BatchGeocode;
  texts?: Partial<BatchTexts>;
  /** Acciones extra por fila (corregir a mano): las aporta el paso siguiente. */
  renderRowActions?: (result: BatchResultRow) => ReactNode;
  /** Apariencia del mapa, o `false` para no ofrecerlo. */
  map?: { theme?: TileThemeName; tiles?: TileConfig } | false;
  /** Formatos de salida, o `false` para no ofrecer exportación. */
  export?: ExportFormatOptions | false;
  /**
   * Acciones para seguir trabajando la tabla (volver a las direcciones,
   * empezar de nuevo). Van **antes** de la exportación: descargar solo tiene
   * sentido cuando la tabla ya quedó como se quiere, y estas dos son
   * justamente las que permiten dejarla así.
   */
  renderActions?: () => ReactNode;
}

/** Plural para los contadores del resumen, singular para una fila. */
function statusLabel(status: BatchStatus, texts: BatchTexts, count: "one" | "many"): string {
  const labels: Record<BatchStatus, [one: string, many: string]> = {
    ok: [texts.rowOk, texts.statusOk],
    uncertain: [texts.rowUncertain, texts.statusUncertain],
    failed: [texts.rowFailed, texts.statusFailed],
    corrected: [texts.rowCorrected, texts.statusCorrected],
    pending: [texts.rowPending, texts.statusPending],
  };
  return labels[status][count === "one" ? 0 : 1];
}

function precisionLabel(precision: Precision, texts: BatchTexts): string {
  switch (precision) {
    case "rooftop":
      return texts.precisionRooftop;
    case "street":
      return texts.precisionStreet;
    case "zone":
      return texts.precisionZone;
    default:
      return texts.precisionExact;
  }
}

function issueLine(code: IssueCode, detail: string | undefined, overrides?: Partial<Record<IssueCode, string>>): string {
  const base = overrides?.[code] ?? DEFAULT_ISSUE_TEXTS[code];
  return detail ? `${base} (${detail})` : base;
}

export function BatchResults({
  batch,
  texts: textsOverride,
  renderRowActions,
  map,
  export: exportable,
  renderActions,
}: BatchResultsProps) {
  const texts: BatchTexts = { ...DEFAULT_BATCH_TEXTS, ...textsOverride };
  const [filter, setFilter] = useState<BatchStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [mapOpen, setMapOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

  const { results, summary } = batch;

  /** Columna que identifica la fila en la planilla de origen, si se mapeó una. */
  const labelIndex = useMemo(() => {
    const index = batch.mapping.indexOf("label");
    return index >= 0 ? index : null;
  }, [batch.mapping]);

  const filtered = useMemo(() => {
    const tokens = normalizeTokens(query);
    return results.filter((result) => {
      if (filter !== "all" && result.status !== filter) return false;
      if (tokens.length === 0) return true;
      // Se busca en lo ingresado y en lo encontrado: quien revisa a veces
      // recuerda lo que escribió y a veces lo que le devolvió el geocoder.
      const haystack = normalizeTokens(
        `${result.row.raw} ${result.value?.formatted ?? ""} ${result.row.cells?.join(" ") ?? ""}`,
      );
      return tokens.every((t) => haystack.some((h) => h.startsWith(t)));
    });
  }, [results, filter, query]);

  const visible = filtered.slice(0, limit);
  const filtering = filter !== "all" || query.trim() !== "";
  const mappable = useMemo(() => filtered.filter((r) => r.value), [filtered]);

  function applyFilter(next: BatchStatus | "all") {
    setFilter(next);
    setLimit(PAGE_SIZE);
    setExpanded(null);
  }

  /**
   * Seleccionar desde el mapa una fila que quedó más allá del tope pintado
   * dejaría el clic sin efecto visible. Se sube el tope hasta alcanzarla.
   */
  useEffect(() => {
    if (!selectedId) return;
    const position = filtered.findIndex((r) => r.row.id === selectedId);
    if (position >= 0 && position >= limit) {
      setLimit(Math.ceil((position + 1) / PAGE_SIZE) * PAGE_SIZE);
    }
  }, [selectedId, filtered, limit]);

  // La fila seleccionada se trae a la vista: en una tabla de cientos de
  // filas, resaltarla sin mostrarla no comunica nada.
  useEffect(() => {
    if (!selectedId) return;
    const row = tableRef.current?.querySelector<HTMLElement>(`[data-row-id="${selectedId}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId, limit]);

  function inspect(rowId: string) {
    setMapOpen(true);
    setSelectedId(rowId);
  }

  function startCorrection(rowId: string) {
    setCorrectingId(rowId);
    setSelectedId(rowId);
  }

  const correcting = correctingId
    ? (results.find((r) => r.row.id === correctingId) ?? null)
    : null;

  return (
    <section className="arb-panel">
      <div className="arb-results-head">
        <h3 className="arb-panel-title">{texts.reviewTitle}</h3>
        {/* El tip va junto al título y no en su propia línea: dice cómo se
            usan los contadores que vienen justo abajo, y así no gasta un
            renglón entero en decirlo. */}
        <span className="arb-muted">{texts.filterHint}</span>
      </div>

      <div className="arb-counters">
        <button
          type="button"
          className={`arb-chip arb-chip-button ${filter === "all" ? "arb-chip-selected" : ""}`}
          onClick={() => applyFilter("all")}
        >
          {texts.filterAll}: {summary.total}
        </button>
        {FILTER_ORDER.map((status) => {
          const count = summary[status];
          // Un contador en cero no aporta y compite por atención con los que
          // sí importan; solo "exitosas" se muestra siempre, porque su
          // ausencia sería la noticia.
          if (count === 0 && status !== "ok") return null;
          return (
            <button
              key={status}
              type="button"
              className={`arb-chip arb-chip-button ${STATUS_CLASS[status]} ${filter === status ? "arb-chip-selected" : ""}`}
              onClick={() => applyFilter(status)}
            >
              {statusLabel(status, texts, "many")}: {count}
            </button>
          );
        })}
      </div>

      <div className="arb-toolbar">
        <input
          type="search"
          className="arb-search"
          value={query}
          placeholder={texts.searchPlaceholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(PAGE_SIZE);
          }}
        />
        {filtering && (
          <button
            type="button"
            className="arb-button arb-button-ghost"
            onClick={() => {
              setQuery("");
              applyFilter("all");
            }}
          >
            {texts.clearFilters}
          </button>
        )}
        {map !== false && (
          <button
            type="button"
            className="arb-button arb-button-ghost"
            disabled={mappable.length === 0}
            aria-expanded={mapOpen}
            onClick={() => setMapOpen((open) => !open)}
          >
            {mapOpen ? texts.hideMap : texts.showMap}
          </button>
        )}
      </div>

      {/* El corrector ocupa el lugar del mapa: los dos traen su propio mapa
          y dos mapas a la vez sobre la misma dirección solo confunden. */}
      {correcting && (
        <Suspense fallback={<div className="arb-map arb-map-loading">{texts.correctionLoading}</div>}>
          <RowCorrection
            result={correcting}
            client={batch.client}
            bias={batch.bias}
            texts={texts}
            map={map === false ? undefined : map}
            onCancel={() => setCorrectingId(null)}
            onResolve={(value) => {
              batch.applyCorrection(correcting.row.id, value);
              setCorrectingId(null);
            }}
          />
        </Suspense>
      )}

      {map !== false && mapOpen && !correcting && (
        <Suspense fallback={<div className="arb-map arb-map-loading">{texts.mapLoading}</div>}>
          {/* El mapa recibe lo filtrado, no todo: si alguien está mirando
              solo las inciertas, ver el resto de los puntos encima haría
              perder justo lo que fue a buscar. */}
          <BatchMap
            results={mappable}
            selectedId={selectedId}
            onSelect={setSelectedId}
            tileTheme={map?.theme}
            tiles={map?.tiles}
          />
        </Suspense>
      )}

      {visible.length === 0 ? (
        <p className="arb-notice">{texts.noRowsForFilter}</p>
      ) : (
        <div className="arb-table-scroll" ref={tableRef}>
          <table className="arb-table arb-table-results">
            <thead>
              <tr>
                <th>{texts.colIndex}</th>
                {labelIndex !== null && <th>{texts.colLabel}</th>}
                <th>{texts.colInput}</th>
                <th>{texts.colStatus}</th>
                {/* La acción va pegada al estado: si no se ve que hay algo
                    que hacer con una fila incierta, no se hace. Al final de
                    la fila, después de coordenadas, pasaba desapercibida. */}
                <th />
                <th>{texts.colReason}</th>
                <th>{texts.colLat}</th>
                <th>{texts.colLng}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((result) => {
                const open = expanded === result.row.id;
                const value = result.value;
                return (
                  <Fragment key={result.row.id}>
                    <tr
                      data-row-id={result.row.id}
                      className={[
                        open ? "arb-row-open" : "",
                        selectedId === result.row.id ? "arb-row-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined}
                    >
                      <td>{result.row.index}</td>
                      {labelIndex !== null && <td>{result.row.cells?.[labelIndex] ?? ""}</td>}
                      <td className="arb-cell-wide" title={result.row.raw}>
                        {result.row.raw}
                      </td>
                      <td>
                        <span className={`arb-chip ${STATUS_CLASS[result.status]}`}>
                          {statusLabel(result.status, texts, "one")}
                        </span>
                      </td>
                      <td className="arb-cell-actions">
                        <RowAction
                          result={result}
                          texts={texts}
                          mapEnabled={map !== false}
                          onOpen={() => startCorrection(result.row.id)}
                        />
                      </td>
                      <td className="arb-cell-wide">
                        {result.issues.length > 0
                          ? issueLine(result.issues[0].code, result.issues[0].detail)
                          : ""}
                        {result.issues.length > 1 && (
                          <span className="arb-muted"> +{result.issues.length - 1}</span>
                        )}
                      </td>
                      <td className="arb-cell-num">{value ? value.lat.toFixed(6) : "—"}</td>
                      <td className="arb-cell-num">{value ? value.lng.toFixed(6) : "—"}</td>
                      <td className="arb-cell-actions">
                        {/*
                         * Una sola acción por fila. Antes había "Ver" y
                         * "Corregir": dos botones que abrían dos mapas
                         * distintos para la misma dirección, y quien
                         * revisaba tenía que adivinar cuál servía. La
                         * etiqueta dice qué va a pasar, y el destino
                         * depende del estado de la fila.
                         */}
                        {renderRowActions?.(result)}
                        <button
                          type="button"
                          className="arb-button arb-button-small"
                          aria-expanded={open}
                          onClick={() => setExpanded(open ? null : result.row.id)}
                        >
                          {open ? texts.hideDetails : texts.rowDetails}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr className="arb-row-detail">
                        <td colSpan={labelIndex !== null ? 9 : 8}>
                          <RowDetail result={result} texts={texts} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {renderActions?.()}

      {exportable !== false && (
        <BatchExport
          results={results}
          filtered={filtered}
          sourceHeaders={batch.sourceHeaders}
          texts={texts}
          format={exportable}
        />
      )}

      {visible.length < filtered.length && (
        <div className="arb-actions">
          <button
            type="button"
            className="arb-button arb-button-ghost"
            onClick={() => setLimit((n) => n + PAGE_SIZE)}
          >
            {texts.showMore}
          </button>
        </div>
      )}
    </section>
  );
}

function RowDetail({ result, texts }: { result: BatchResultRow; texts: BatchTexts }) {
  const value = result.value;
  const components = value
    ? Object.entries(value.components).filter(([, v]) => Boolean(v))
    : [];

  return (
    <div className="arb-detail">
      {result.issues.length > 0 && (
        <ul className="arb-detail-issues">
          {result.issues.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>{issueLine(issue.code, issue.detail)}</li>
          ))}
        </ul>
      )}

      <dl className="arb-detail-grid">
        <div>
          <dt>{texts.detailQuery}</dt>
          <dd>{result.row.query}</dd>
        </div>
        {value && (
          <>
            <div>
              <dt>{texts.detailPrecision}</dt>
              <dd>{precisionLabel(value.precision, texts)}</dd>
            </div>
            <div>
              <dt>{texts.detailProvider}</dt>
              <dd>{value.provider}</dd>
            </div>
            <div>
              <dt>{texts.detailComponents}</dt>
              <dd>
                {components.length > 0
                  ? components.map(([key, v]) => `${key}: ${v}`).join(" · ")
                  : "—"}
              </dd>
            </div>
          </>
        )}
      </dl>

      {result.fromDuplicate && <p className="arb-muted">{texts.detailDuplicate}</p>}
    </div>
  );
}

/**
 * La acción de una fila.
 *
 * **Todas abren el mismo diálogo**, y todas permiten corregir. Cambia solo
 * la etiqueta, que dice con qué se va a encontrar:
 *
 * - Exitosa o ya corregida → **Ver**. Mirar el punto de esa dirección, no
 *   el lote entero: para eso está el botón de arriba. Y si al mirarlo
 *   resulta que está mal, se arregla ahí mismo sin volver atrás.
 * - Incierta → **Revisar**.
 * - Fallida → **Buscar**: no hay punto, hay que encontrarlo.
 *
 * Que la fila corregida diga "Ver" como el resto no es cosmético: si
 * siguiera diciendo "Revisar" parecería que la corrección recién hecha no
 * resultó.
 */
function RowAction({
  result,
  texts,
  mapEnabled,
  onOpen,
}: {
  result: BatchResultRow;
  texts: BatchTexts;
  mapEnabled: boolean;
  onOpen: () => void;
}) {
  if (result.status === "pending") return null;

  const resuelta = result.status === "ok" || result.status === "corrected";
  // Sin mapa, mirar un punto no lleva a ninguna parte; el detalle lo cubre.
  if (resuelta && (!mapEnabled || !result.value)) return null;

  const etiqueta = resuelta ? texts.viewOnMap : result.value ? texts.reviewRow : texts.searchRow;
  return (
    <button
      type="button"
      className={`arb-button arb-button-small ${resuelta ? "" : "arb-button-review"}`}
      onClick={onOpen}
    >
      {etiqueta}
    </button>
  );
}
