import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearSnapshot, loadSnapshot, saveSnapshot, type BatchSnapshot } from "./snapshot.ts";
import {
  addressKey,
  buildRows,
  estimateBatchMs,
  estimateBatchQueries,
  guessMapping,
  haversineMeters,
  parseInputText,
  runBatch,
  summarize,
  type AddressFields,
  type BatchInputRow,
  type BatchProgress,
  type BatchResultRow,
  type BatchRunResult,
  type BatchStopReason,
  type BatchSummary,
  type ClassifyOptions,
  type ColumnRole,
  type GeoBias,
  type GeoClient,
  type LocationValue,
  type OutlierOptions,
  type ParsedInput,
  type QuotaStatus,
} from "@allride/geo-core";

/**
 * `useBatchGeocode` — máquina de estados completa del elemento masivo, sin
 * una sola etiqueta HTML.
 *
 * Mismo patrón que `useAddressCapture` en el elemento individual: quien
 * quiera otra apariencia usa el hook y arma su UI; `<AddressBatch>` es solo
 * la implementación de referencia.
 */

export type BatchPhase =
  /** Escribiendo o pegando direcciones. */
  | "input"
  /** Se detectaron columnas y hay que confirmar qué es cada una. */
  | "mapping"
  /** Procesando: la interfaz debe quedar bloqueada. */
  | "running"
  /** Terminado (o cancelado): hay resultados que revisar. */
  | "review";

/** Tabla ya leída de un archivo (XLSX, CSV) por quien integra el elemento. */
export interface LoadedTable {
  headers: string[] | null;
  rows: string[][];
  fileName?: string;
}

export interface BatchGeocodeConfig {
  client: GeoClient;
  bias: GeoBias;
  /**
   * Tope de direcciones por lote. Sin valor no hay tope: una herramienta
   * pública anónima querrá 100, una interna con usuarios autenticados
   * probablemente ninguno.
   */
  maxRows?: number;
  concurrency?: number;
  /** Ritmo mínimo entre consultas; depende del plan del proveedor. */
  minIntervalMs?: number;
  /** Datos que aplican a todo el lote: país, región, ciudad. */
  defaults?: AddressFields;
  classify?: ClassifyOptions;
  outliers?: OutlierOptions | false;
  /**
   * Clave de almacenamiento local para poder retomar un lote interrumpido.
   * Sin ella no se guarda nada — que es lo correcto en una herramienta
   * pública compartida, donde el avance de una persona no debería quedar
   * en el navegador para la siguiente.
   */
  storageKey?: string;
  onComplete?: (result: BatchRunResult) => void;
}

export interface BatchStats {
  /** Filas que se van a procesar (ya recortadas al tope). */
  total: number;
  /** Consultas que se van a gastar: el total menos los duplicados. */
  queries: number;
  duplicates: number;
  emptyRows: number;
  droppedOverLimit: number;
}

export interface BatchGeocode {
  phase: BatchPhase;
  /** true mientras corre: la UI no debe permitir nada más que cancelar. */
  busy: boolean;

  // --- entrada ---
  text: string;
  setText: (text: string) => void;
  loaded: LoadedTable | null;
  loadTable: (table: LoadedTable) => void;
  clearLoaded: () => void;
  parsed: ParsedInput;
  /** Rol de cada columna cuando la entrada es tabular. */
  mapping: ColumnRole[];
  setMapping: (mapping: ColumnRole[]) => void;
  /** Encabezados a mostrar en el mapeo (los del archivo, o "Columna N"). */
  columnLabels: string[];
  /** Primeras filas, para previsualizar el mapeo. */
  preview: string[][];

  rows: BatchInputRow[];
  stats: BatchStats;
  /** Duración estimada del lote, en ms. */
  estimateMs: number;
  /**
   * Cuánta cuota diaria propia queda, si el transporte la expone (solo
   * `httpClient`). `null` mientras se consulta o si no aplica; la UI debe
   * tratarlo como "no hay aviso que dar", nunca como error.
   */
  quotaStatus: QuotaStatus | null;
  /**
   * Filas que ya están resueltas de una corrida anterior de esta sesión y
   * no se van a volver a consultar.
   */
  reusable: number;
  /** Encabezados originales, para devolverlos en la exportación. */
  sourceHeaders: string[] | null;

  // --- proceso ---
  start: () => void;
  /**
   * Últimos resultados, para pintarlos mientras el lote corre. Ver
   * direcciones reales apareciendo comunica avance mucho mejor que una
   * barra: es progreso de contenido y no de una abstracción.
   */
  recent: BatchResultRow[];
  cancel: () => void;
  progress: BatchProgress | null;

  // --- resultados ---
  results: BatchResultRow[];
  summary: BatchSummary;
  cancelled: boolean;
  /**
   * Por qué se detuvo antes de terminar, cuando no fue la persona quien lo
   * canceló: cuota diaria agotada, credencial rechazada o el servicio
   * caído. `null` en un lote que corrió completo o que la persona detuvo
   * a mano.
   */
  stopReason: BatchStopReason;
  /** Reemplaza una fila cualquiera. */
  replaceResult: (rowId: string, next: BatchResultRow) => void;
  /**
   * Da por buena una corrección hecha a mano. El punto confirmado por la
   * persona reemplaza al del geocoder y se propaga a las filas repetidas.
   */
  applyCorrection: (rowId: string, value: LocationValue) => void;
  /** Lo que se le pasó al hook, para que la UI de corrección lo reuse. */
  client: GeoClient;
  bias: GeoBias;
  /** Lote a medias encontrado al cargar, si `storageKey` está configurada. */
  resumable: BatchSnapshot | null;
  /** Retoma el lote guardado sin volver a consultar lo ya resuelto. */
  resume: () => void;
  /** Descarta el lote guardado. */
  discardResumable: () => void;
  /** Vuelve a la entrada conservando el texto. */
  backToInput: () => void;
  /** Deja todo como al principio. */
  reset: () => void;
}

const EMPTY_PARSED: ParsedInput = { kind: "lines", lines: [] };

/** ¿Es el mismo punto? Un metro de tolerancia cubre el redondeo del mapa. */
function sameSpot(a: LocationValue, b: LocationValue): boolean {
  return haversineMeters(a, b) < 1;
}

export function useBatchGeocode(config: BatchGeocodeConfig): BatchGeocode {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState<LoadedTable | null>(null);
  const [mappingOverride, setMappingOverride] = useState<ColumnRole[] | null>(null);
  const [phase, setPhase] = useState<BatchPhase>("input");
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [results, setResults] = useState<BatchResultRow[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [stopReason, setStopReason] = useState<BatchStopReason>(null);
  const [quotaStatus, setQuotaStatus] = useState<QuotaStatus | null>(null);

  /*
   * Se consulta una sola vez, al montar: es el aviso previo a arrancar, no
   * algo que deba reflejar cada tecla que se escribe en el textarea. Un
   * cliente directo (sin backend propio) simplemente no tiene `quota` y
   * esto queda en `null` para siempre, que es justo "no hay aviso que dar".
   */
  useEffect(() => {
    if (!config.client.quota) return;
    const controller = new AbortController();
    config.client
      .quota(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) setQuotaStatus(status);
      })
      .catch(() => {});
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Se lee una sola vez, al montar: si se releyera en cada render, retomar
   * y luego guardar avance nuevo se pisarían entre sí.
   */
  const [resumable, setResumable] = useState<BatchSnapshot | null>(() =>
    config.storageKey ? loadSnapshot(config.storageKey) : null,
  );

  const abortRef = useRef<AbortController | null>(null);
  /** Resultados acumulados de la corrida en curso, para la instantánea. */
  const liveRef = useRef<BatchResultRow[]>([]);
  const lastSaveRef = useRef(0);
  const [recent, setRecent] = useState<BatchResultRow[]>([]);
  const recentRef = useRef<BatchResultRow[]>([]);
  const lastRecentRef = useRef(0);

  /**
   * Todo lo que esta sesión ya resolvió, por dirección normalizada.
   *
   * El flujo real es iterativo: se procesa, se ven las que fallaron, se
   * corrige el texto y se vuelve a procesar. Sin esto, editar tres líneas
   * de quinientas cuesta quinientas consultas de nuevo. Se indexa por
   * dirección y no por id de fila porque los ids se corren al editar el
   * texto.
   */
  const resolvedRef = useRef(new Map<string, BatchResultRow>());
  /**
   * El progreso se refresca a lo más cada 100 ms. Sin esto, un lote de
   * 2.000 direcciones dispara 2.000 renders y la pestaña se pone lenta
   * justo cuando la persona está mirando la barra avanzar.
   */
  const lastEmitRef = useRef(0);

  const parsed = useMemo<ParsedInput>(() => {
    if (loaded) {
      return loaded.headers
        ? { kind: "table", delimiter: "\t", headers: loaded.headers, rows: loaded.rows }
        : { kind: "table", delimiter: "\t", headers: null, rows: loaded.rows };
    }
    return text.trim() ? parseInputText(text) : EMPTY_PARSED;
  }, [loaded, text]);

  const autoMapping = useMemo<ColumnRole[]>(() => {
    if (parsed.kind !== "table") return [];
    if (parsed.headers) return guessMapping(parsed.headers);
    // Sin encabezados, `buildRows` deduce por contenido; acá solo se
    // necesita un arreglo del ancho correcto para que la UI lo pueda editar.
    const width = Math.max(0, ...parsed.rows.map((r) => r.length));
    return Array.from({ length: width }, () => "ignore" as ColumnRole);
  }, [parsed]);

  const mapping = mappingOverride ?? autoMapping;

  const built = useMemo(
    () =>
      buildRows(parsed, {
        mapping: parsed.kind === "table" && mappingOverride ? mappingOverride : undefined,
        maxRows: config.maxRows,
        defaults: config.defaults,
      }),
    [parsed, mappingOverride, config.maxRows, config.defaults],
  );

  const stats = useMemo<BatchStats>(
    () => ({
      total: built.rows.length,
      queries: estimateBatchQueries(built.rows),
      duplicates: built.duplicates,
      emptyRows: built.emptyRows,
      droppedOverLimit: built.droppedOverLimit,
    }),
    [built],
  );

  const estimateMs = useMemo(
    () =>
      estimateBatchMs(built.rows, {
        concurrency: config.concurrency,
        minIntervalMs: config.minIntervalMs,
      }),
    [built.rows, config.concurrency, config.minIntervalMs],
  );

  const columnLabels = useMemo(() => {
    if (parsed.kind !== "table") return [];
    const width = Math.max(0, ...parsed.rows.map((r) => r.length));
    return Array.from({ length: width }, (_, i) => parsed.headers?.[i] || `Columna ${i + 1}`);
  }, [parsed]);

  const preview = useMemo(() => (parsed.kind === "table" ? parsed.rows.slice(0, 3) : []), [parsed]);

  const run = useCallback(
    (rows: BatchInputRow[], previous: BatchResultRow[], sourceHeaders: string[] | null) => {
      if (rows.length === 0) return;
      const controller = new AbortController();
      abortRef.current = controller;
      lastEmitRef.current = 0;
      lastSaveRef.current = 0;
      liveRef.current = [...previous];
      recentRef.current = [];
      lastRecentRef.current = 0;
      setRecent([]);
      setCancelled(false);
      setStopReason(null);
      setResults([]);
      setProgress(null);
      setResumable(null);
      setPhase("running");

      const { storageKey } = config;

      void runBatch(rows, {
        client: config.client,
        bias: config.bias,
        concurrency: config.concurrency,
        minIntervalMs: config.minIntervalMs,
        classify: config.classify,
        outliers: config.outliers,
        previous,
        signal: controller.signal,
        onResult: (result) => {
          resolvedRef.current.set(addressKey(result.row), result);

          // Cola corta de lo último resuelto, refrescada a lo más 4 veces
          // por segundo: pintar cada fila al llegar haría 500 renders.
          recentRef.current = [result, ...recentRef.current].slice(0, 8);
          const ahora = Date.now();
          if (ahora - lastRecentRef.current > 250) {
            lastRecentRef.current = ahora;
            setRecent(recentRef.current);
          }

          if (!storageKey) return;
          liveRef.current.push(result);
          /*
           * Se guarda cada 2 segundos, no en cada fila: serializar el lote
           * entero 500 veces cuesta más que el geocoding, y perder los
           * últimos segundos de avance al cerrar la pestaña no es grave —
           * lo que importa es no perder los últimos 20 minutos.
           */
          const now = Date.now();
          if (now - lastSaveRef.current < 2000) return;
          lastSaveRef.current = now;
          saveSnapshot(storageKey, rows, liveRef.current, sourceHeaders);
        },
        onProgress: (p) => {
          const now = Date.now();
          if (p.done < p.total && now - lastEmitRef.current < 100) return;
          lastEmitRef.current = now;
          setProgress(p);
        },
      }).then((result) => {
        abortRef.current = null;
        for (const fila of result.results) {
          if (fila.status !== "pending") resolvedRef.current.set(addressKey(fila.row), fila);
        }
        setResults(result.results);
        setCancelled(result.cancelled);
        setStopReason(result.stopReason);
        setPhase("review");
        if (storageKey) {
          // Un lote cancelado se conserva para poder retomarlo; uno
          // completo ya no tiene nada que retomar y solo ocuparía espacio.
          if (result.cancelled) saveSnapshot(storageKey, rows, result.results, sourceHeaders);
          else clearSnapshot(storageKey);
        }
        config.onComplete?.(result);
      });
    },
    [config],
  );

  /** Resultados ya conocidos para estas filas, re-apuntados a sus ids actuales. */
  const reuseFor = useCallback((rows: BatchInputRow[]): BatchResultRow[] => {
    const out: BatchResultRow[] = [];
    for (const row of rows) {
      const previo = resolvedRef.current.get(addressKey(row));
      // Lo corregido a mano también se reusa: si alguien ya movió ese pin,
      // volver a preguntarle al geocoder sería deshacer su trabajo.
      if (previo && previo.status !== "pending") out.push({ ...previo, row });
    }
    return out;
  }, []);

  const reusable = useMemo(() => reuseFor(built.rows).length, [reuseFor, built.rows, results]);

  const start = useCallback(() => {
    run(built.rows, reuseFor(built.rows), built.sourceHeaders);
  }, [run, built.rows, built.sourceHeaders, reuseFor]);

  const resume = useCallback(() => {
    if (!resumable) return;
    run(resumable.rows, resumable.results, resumable.sourceHeaders);
  }, [run, resumable]);

  const discardResumable = useCallback(() => {
    if (config.storageKey) clearSnapshot(config.storageKey);
    setResumable(null);
  }, [config.storageKey]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const replaceResult = useCallback((rowId: string, next: BatchResultRow) => {
    setResults((current) => current.map((r) => (r.row.id === rowId ? next : r)));
  }, []);

  const applyCorrection = useCallback((rowId: string, value: LocationValue) => {
    setResults((current) => {
      const target = current.find((r) => r.row.id === rowId);
      if (!target) return current;

      /*
       * Abrir "Ver" en una fila exitosa y confirmar el pin sin moverlo no
       * es una corrección: no cambió nada. Marcarla como "Corregida" diría
       * que una persona intervino un dato que en realidad resolvió el
       * geocoder, y esa distinción es justamente la que la exportación
       * promete. En cambio, confirmar un punto **incierto** sin moverlo sí
       * es una decisión: alguien lo miró y lo dio por bueno.
       */
      if (target.status === "ok" && target.value && sameSpot(target.value, value)) return current;
      /*
       * Las filas repetidas heredaron el resultado malo, así que corregir
       * solo la que se está mirando dejaría a las otras con un punto que ya
       * se sabe equivocado — y nadie volvería a revisarlas, porque el
       * resumen mostraría el problema como resuelto. Se propaga a toda la
       * familia: la original y todas las que la copian.
       */
      const family = target.row.duplicateOf ?? target.row.id;
      const correctedAt = new Date().toISOString();

      return current.map((r) => {
        if ((r.row.duplicateOf ?? r.row.id) !== family) return r;
        const corregida: BatchResultRow = {
          ...r,
          status: "corrected",
          value,
          // El nivel de match era del geocoder; acá el punto lo puso una
          // persona y esa clasificación deja de tener sentido.
          matchedLevel: null,
          issues: [],
          correctedAt,
          fromDuplicate: r.row.id !== rowId,
        };
        resolvedRef.current.set(addressKey(r.row), corregida);
        return corregida;
      });
    });
  }, []);

  const backToInput = useCallback(() => {
    setPhase("input");
    setProgress(null);
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    liveRef.current = [];
    recentRef.current = [];
    setRecent([]);
    resolvedRef.current.clear();
    if (config.storageKey) clearSnapshot(config.storageKey);
    setResumable(null);
    setText("");
    setLoaded(null);
    setMappingOverride(null);
    setResults([]);
    setProgress(null);
    setCancelled(false);
    setStopReason(null);
    setPhase("input");
  }, [config.storageKey]);

  const loadTable = useCallback((table: LoadedTable) => {
    setLoaded(table);
    setText("");
    // Un archivo nuevo trae otras columnas: conservar el mapeo del anterior
    // asignaría roles a columnas que ya no son las mismas.
    setMappingOverride(null);
    setPhase("input");
  }, []);

  const clearLoaded = useCallback(() => {
    setLoaded(null);
    setMappingOverride(null);
  }, []);

  const setMapping = useCallback((next: ColumnRole[]) => setMappingOverride(next), []);

  const summary = useMemo(() => summarize(results), [results]);

  return {
    phase: phase === "input" && parsed.kind === "table" ? "mapping" : phase,
    busy: phase === "running",
    text,
    setText: (value: string) => {
      setText(value);
      setMappingOverride(null);
    },
    loaded,
    loadTable,
    clearLoaded,
    parsed,
    mapping,
    setMapping,
    columnLabels,
    preview,
    rows: built.rows,
    stats,
    estimateMs,
    quotaStatus,
    reusable,
    sourceHeaders: built.sourceHeaders,
    start,
    recent,
    cancel,
    progress,
    results,
    summary,
    cancelled,
    stopReason,
    replaceResult,
    applyCorrection,
    resumable,
    resume,
    discardResumable,
    client: config.client,
    bias: config.bias,
    backToInput,
    reset,
  };
}
