import type { BatchInputRow, BatchResultRow, BatchStatus, IssueCode, LocationValue, MatchedLevel } from "@allride/geo-core";

/**
 * Instantánea de un lote en curso, para poder retomarlo.
 *
 * Un lote de 5.000 direcciones con LocationIQ gratuito tarda cerca de 40
 * minutos. En ese rato es perfectamente normal que alguien cierre la
 * pestaña sin querer, se le reinicie el equipo o simplemente crea que ya
 * terminó — y volver a empezar de cero significa pagar de nuevo toda la
 * cuota ya consumida, además del tiempo.
 *
 * Se guarda comprimida a propósito: `BatchResultRow` lleva adentro la fila
 * de entrada completa, y almacenarla dos veces (una en `rows` y otra dentro
 * de cada resultado) duplicaría el tamaño para nada.
 */

const VERSION = 2;

interface StoredResult {
  id: string;
  status: BatchStatus;
  value: LocationValue | null;
  matchedLevel: MatchedLevel | null;
  issues: Array<{ code: IssueCode; detail?: string }>;
  correctedAt?: string;
  fromDuplicate?: boolean;
}

interface StoredSnapshot {
  version: number;
  savedAt: string;
  rows: BatchInputRow[];
  results: StoredResult[];
  sourceHeaders: string[] | null;
}

export interface BatchSnapshot {
  savedAt: Date;
  rows: BatchInputRow[];
  results: BatchResultRow[];
  sourceHeaders: string[] | null;
  /** Filas ya resueltas, para poder decir "vas en 320 de 500". */
  done: number;
  total: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Safari en navegación privada y algunas políticas de cookies lanzan
    // al solo tocar localStorage. No poder guardar no debe romper el lote.
    return null;
  }
}

export function saveSnapshot(
  key: string,
  rows: BatchInputRow[],
  results: BatchResultRow[],
  sourceHeaders: string[] | null,
): boolean {
  const store = storage();
  if (!store) return false;

  const snapshot: StoredSnapshot = {
    version: VERSION,
    savedAt: new Date().toISOString(),
    rows,
    // Las pendientes no se guardan: son justamente las que hay que rehacer.
    results: results
      .filter((r) => r.status !== "pending")
      .map((r) => ({
        id: r.row.id,
        status: r.status,
        value: r.value,
        matchedLevel: r.matchedLevel,
        issues: r.issues,
        correctedAt: r.correctedAt,
        fromDuplicate: r.fromDuplicate,
      })),
    sourceHeaders,
  };

  try {
    store.setItem(key, JSON.stringify(snapshot));
    return true;
  } catch {
    /*
     * localStorage ronda los 5 MB y un lote grande lo llena. Se descarta la
     * instantánea y se sigue: perder la posibilidad de retomar es molesto,
     * pero abortar el lote por no poder guardar el respaldo sería absurdo.
     */
    console.warn("[address-batch] no se pudo guardar el avance del lote (¿almacenamiento lleno?).");
    try {
      store.removeItem(key);
    } catch {
      /* nada que hacer */
    }
    return false;
  }
}

export function loadSnapshot(key: string): BatchSnapshot | null {
  const store = storage();
  if (!store) return null;

  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSnapshot;
    // Una instantánea de una versión anterior del formato se descarta en
    // vez de intentar interpretarla: retomar con datos mal leídos es peor
    // que volver a empezar.
    if (parsed.version !== VERSION || !Array.isArray(parsed.rows)) return null;

    const byId = new Map(parsed.rows.map((row) => [row.id, row]));
    const results: BatchResultRow[] = [];
    for (const stored of parsed.results ?? []) {
      const row = byId.get(stored.id);
      if (!row) continue;
      results.push({
        row,
        status: stored.status,
        value: stored.value,
        matchedLevel: stored.matchedLevel,
        issues: stored.issues ?? [],
        correctedAt: stored.correctedAt,
        fromDuplicate: stored.fromDuplicate,
      });
    }

    return {
      savedAt: new Date(parsed.savedAt),
      rows: parsed.rows,
      results,
      sourceHeaders: parsed.sourceHeaders ?? null,
      done: results.length,
      total: parsed.rows.length,
    };
  } catch {
    return null;
  }
}

/**
 * Todas las filas del lote guardado, con las que no llegaron a resolverse
 * marcadas "sin procesar".
 *
 * `snapshot.results` no las trae —se guardan solo las resueltas, ver
 * `saveSnapshot`— pero exportar solo esas dejaría un archivo sin forma de
 * saber a qué fila de la planilla original corresponde cada una. Es el
 * mismo motivo por el que la exportación de un lote terminado nunca omite
 * las fallidas: una planilla a la que le faltan filas se cruza mal.
 */
export function snapshotResultsForExport(snapshot: BatchSnapshot): BatchResultRow[] {
  const byId = new Map(snapshot.results.map((r) => [r.row.id, r]));
  return snapshot.rows.map(
    (row): BatchResultRow =>
      byId.get(row.id) ?? { row, status: "pending", value: null, matchedLevel: null, issues: [] },
  );
}

export function clearSnapshot(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* nada que hacer */
  }
}
