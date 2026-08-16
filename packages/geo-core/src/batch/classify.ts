import type { GeoBias, GeocodeOutcome, LocationValue, MatchedLevel } from "../types.ts";
import { haversineMeters } from "../types.ts";
import { adminAreaMatches, normalizeTokens, textCoverage } from "../relevance.ts";
import { canonicalAdminArea } from "../admin/index.ts";
import { streetTokens, type BatchInputRow } from "./parse.ts";

/**
 * Clasificación de un resultado de geocodificación masiva.
 *
 * En captura individual quien escribe ve el resultado y lo confirma: el
 * error se corrige solo. En masivo nadie mira fila por fila, así que un
 * resultado mediocre entra al análisis como si fuera bueno. La herramienta
 * pública actual muestra "OK" cuando el geocoder devolvió la calle **sin la
 * altura** —el punto queda a cuadras del domicilio real— y eso es
 * precisamente lo que este módulo separa.
 *
 * De ahí los tres estados: `ok` se puede usar sin mirar, `uncertain` hay
 * que revisarlo, `failed` no hay nada que usar. Cada estado incierto viene
 * con el motivo, porque "revisar 40 direcciones" sin decir por qué no
 * ayuda a nadie.
 */

export type BatchStatus =
  | "pending"
  | "ok"
  | "uncertain"
  | "failed"
  /** Resuelto a mano por la persona; el pin confirmado manda. */
  | "corrected";

export type IssueCode =
  // --- inciertos ---
  /** Se pidió una altura y el geocoder solo ubicó la calle. */
  | "no_house_number"
  /** Devolvió una altura distinta de la pedida. */
  | "number_mismatch"
  /** Cayó en el centro de una comuna o ciudad, no en una dirección. */
  | "zone_only"
  /** Lo que devolvió no se parece en general a lo que se pidió. */
  | "weak_match"
  /** Devolvió otra calle: el nombre no coincide con el buscado. */
  | "street_mismatch"
  /** El punto no cae en la comuna declarada en la planilla. */
  | "outside_admin_area"
  /** Quedó lejos de la zona de operación configurada. */
  | "far_from_bias"
  /** Quedó lejos de todas las demás direcciones del lote. */
  | "far_from_batch"
  // --- fallidos ---
  /** El proveedor no devolvió ningún candidato. */
  | "no_result"
  /** El proveedor falló (red, cuota, caída) tras los reintentos. */
  | "provider_error"
  /** La fila quedó sin texto que buscar. */
  | "empty_query";

export interface BatchIssue {
  code: IssueCode;
  /** Dato concreto que originó el aviso, para mostrarlo en la tabla. */
  detail?: string;
}

export interface BatchResultRow {
  row: BatchInputRow;
  status: BatchStatus;
  value: LocationValue | null;
  matchedLevel: MatchedLevel | null;
  issues: BatchIssue[];
  /** ISO 8601, cuando la persona corrigió el punto a mano. */
  correctedAt?: string;
  /** Copiado de otra fila idéntica en vez de consultado al proveedor. */
  fromDuplicate?: boolean;
}

/** Textos por defecto, sobreescribibles por la UI (misma convención que `texts`). */
export const DEFAULT_ISSUE_TEXTS: Record<IssueCode, string> = {
  no_house_number: "Se encontró la calle pero no la altura: el punto es aproximado.",
  number_mismatch: "La altura encontrada no es la que se pidió.",
  zone_only: "Cayó en el centro de la zona, no en una dirección.",
  weak_match: "Lo encontrado no se parece a lo que se buscó.",
  street_mismatch: "El nombre de la calle encontrada no coincide con la buscada.",
  outside_admin_area: "El punto no está en la comuna declarada.",
  far_from_bias: "Quedó lejos de la zona de operación configurada.",
  far_from_batch: "Quedó lejos del resto de las direcciones del lote.",
  no_result: "No se encontró ninguna dirección.",
  provider_error: "El servicio de direcciones no respondió.",
  empty_query: "La fila quedó sin dirección que buscar.",
};

const FAILURE_CODES: ReadonlySet<IssueCode> = new Set<IssueCode>([
  "no_result",
  "provider_error",
  "empty_query",
]);

export interface ClassifyOptions {
  bias?: GeoBias;
  /**
   * Cobertura mínima del texto buscado para no marcar `weak_match`. Mismo
   * umbral que usa el elemento individual para decidir si ofrece salidas.
   */
  minCoverage?: number;
}

/**
 * Todo el texto conocido del resultado: la dirección formateada **y sus
 * componentes**.
 *
 * Comparar solo contra `formatted` era un error que castigaba a quien daba
 * más información. Los proveedores OSM no arman `formatted` con todos los
 * campos que sí devuelven: para "moneda 1025, las condes", LocationIQ
 * responde `formatted: "Moneda 1025, Santiago, …"` y deja "Las Condes" en
 * `sublocality`. La comuna que la persona escribió —la que le pedimos
 * escribir para mejorar la precisión— no aparecía en la comparación, la
 * cobertura caía a 0,50 y una dirección exacta terminaba marcada como
 * incierta.
 *
 * El síntoma delator: la misma dirección **sin** comuna pasaba como
 * exitosa. Escribir más datos empeoraba el resultado.
 */
function resultText(value: LocationValue): string {
  const c = value.components;
  return [
    value.formatted,
    c.street, c.number, c.sublocality, c.commune,
    c.city, c.region, c.postalCode, c.country,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Alturas escritas en el texto buscado (posibles números de calle). */
function numbersIn(text: string): string[] {
  // Se descartan números de 5+ dígitos: son códigos postales o RUT, no alturas.
  return normalizeTokens(text).filter((t) => /^\d{1,4}$/.test(t));
}

/**
 * Nombre de calle que se pidió. Con campos separados es directo; en texto
 * libre es lo que va antes de la altura ("Av. Grecia 3000, Ñuñoa" →
 * "Av. Grecia"), porque después de la altura viene la comuna.
 *
 * Se lee de `query` y no de `raw` porque `query` ya viene limpio: en
 * "Torre B, Av. Grecia 3000" el primer trozo del texto original es "Torre
 * B", que no se parece en nada a "Avenida Grecia" y marcaba la fila como
 * calle equivocada sin que nada estuviera mal.
 */
function expectedStreet(row: BatchInputRow): string | null {
  if (row.fields?.street) return row.fields.street;
  const text = row.query.split(",")[0] ?? "";
  const cut = text.search(/\d/);
  const head = (cut > 0 ? text.slice(0, cut) : text).trim();
  return head || null;
}

/**
 * Clasifica un resultado individual. El chequeo de outliers vive aparte
 * (`detectOutliers`) porque necesita el lote completo para tener sentido.
 */
export function classifyResult(
  row: BatchInputRow,
  outcome: GeocodeOutcome | null,
  opts: ClassifyOptions = {},
): BatchResultRow {
  const base = { row, value: null, matchedLevel: null } as const;

  if (!row.query.trim()) {
    return { ...base, status: "failed", issues: [{ code: "empty_query" }] };
  }
  if (!outcome) {
    return { ...base, status: "failed", issues: [{ code: "no_result" }] };
  }

  const { value, matchedLevel } = outcome;
  const issues: BatchIssue[] = [];
  const asked = numbersIn(row.query);

  if (matchedLevel === "zone") {
    issues.push({ code: "zone_only", detail: value.formatted });
  } else if (asked.length > 0 && !value.components.number) {
    // Solo cuenta como falta si se pidió una altura: "Plaza de Armas,
    // Santiago" a nivel de calle es el mejor resultado posible, no un aviso.
    issues.push({ code: "no_house_number", detail: asked[0] });
  }

  if (asked.length > 0 && value.components.number && !asked.includes(value.components.number)) {
    issues.push({
      code: "number_mismatch",
      detail: `se pidió ${asked[0]}, se encontró ${value.components.number}`,
    });
  }

  const coverage = textCoverage(row.query, resultText(value));
  if (coverage < (opts.minCoverage ?? 0.7)) {
    issues.push({ code: "weak_match", detail: value.formatted });
  }

  /*
   * La cobertura general no basta para el caso más caro: pedir "Av. Grecia
   * 1700, Peñalolén" y recibir "Av. Grecia Norte 3000, Peñalolén" cubre 3 de 4
   * tokens —75%, por encima del umbral— con precisión de dirección exacta.
   * Se ve impecable y está en otra calle. En captura individual la persona
   * lo nota al leer la sugerencia; en un lote de 500 nadie lo nota.
   * Comparar el nombre de la calle aparte, ignorando el tipo de vía, es lo
   * que separa ese caso de un match legítimo.
   */
  const askedStreet = expectedStreet(row);
  if (askedStreet && value.components.street) {
    const wanted = streetTokens(askedStreet);
    const got = streetTokens(value.components.street);
    if (wanted.length > 0 && got.length > 0) {
      const matched = wanted.filter((w) => got.some((g) => g.startsWith(w) || w.startsWith(g)));
      if (matched.length / wanted.length < 0.6) {
        issues.push({
          code: "street_mismatch",
          detail: `se buscó "${askedStreet.trim()}", se encontró "${value.components.street}"`,
        });
      }
    }
  }

  /*
   * Solo se puede contradecir lo declarado si el resultado trae con qué.
   * Cuando el proveedor no devolvió ninguna división administrativa —pasa
   * en direcciones rurales y con proveedores parcos—, decir "el punto no
   * está en la comuna declarada" es afirmar algo que nadie verificó: no hay
   * desacuerdo, hay silencio.
   */
  if (row.adminArea && hasAdminInfo(value) && !adminAreaMatches(value, row.adminArea)) {
    issues.push({ code: "outside_admin_area", detail: row.adminArea.name });
  }

  if (opts.bias?.center) {
    const km = haversineMeters(value, opts.bias.center) / 1000;
    // Mismo umbral conservador que el parser de coordenadas: solo avisa
    // ante un disparate, no ante alguien que vive lejos.
    if (km > Math.max((opts.bias.radiusKm ?? 50) * 3, 300)) {
      issues.push({ code: "far_from_bias", detail: `${Math.round(km)} km` });
    }
  }

  return {
    row,
    status: issues.length > 0 ? "uncertain" : "ok",
    value: withDeclaredCommune(value, row, issues, opts.bias?.country),
    matchedLevel,
    issues,
  };
}

/** ¿El resultado trae alguna división administrativa? */
function hasAdminInfo(value: LocationValue): boolean {
  const c = value.components;
  return Boolean(c.commune || c.city || c.sublocality || c.region);
}

/**
 * Completa la comuna con la que declaró la planilla cuando el proveedor no
 * devolvió ninguna.
 *
 * Es un dato que ya estaba y se estaba tirando: quien carga una nómina con
 * columna "Comuna" la escribió, la usamos para acotar la búsqueda, y aun
 * así la planilla exportada volvía con esa celda vacía. Completarla no
 * inventa nada — es la misma columna que entró.
 *
 * Nunca pisa lo que sí devolvió el proveedor, y nunca completa una fila
 * marcada como fuera de la comuna declarada: ahí lo declarado y lo
 * encontrado se contradicen, y esa contradicción es justamente lo que hay
 * que mostrar en vez de tapar.
 */
function withDeclaredCommune(
  value: LocationValue,
  row: BatchInputRow,
  issues: BatchIssue[],
  country: string | null | undefined,
): LocationValue {
  const declarada = row.adminArea?.name;
  if (!declarada || value.components.commune) return value;
  if (issues.some((issue) => issue.code === "outside_admin_area")) return value;

  return {
    ...value,
    components: {
      ...value.components,
      // La grafía del catálogo y no la escrita: la columna Comuna del
      // export tiene que poder filtrarse, y "nunoa" no agrupa con "Ñuñoa".
      commune: canonicalAdminArea(country ?? value.components.country, declarada) ?? declarada,
    },
  };
}

/** Resultado de un intento fallido del proveedor (tras agotar reintentos). */
export function failedResult(row: BatchInputRow, error: string): BatchResultRow {
  return {
    row,
    status: "failed",
    value: null,
    matchedLevel: null,
    issues: [{ code: "provider_error", detail: error }],
  };
}

// ---------- outliers del lote ----------

export interface OutlierOptions {
  /**
   * Mínimo de puntos para que la estadística signifique algo. Con tres
   * direcciones no hay "resto del lote" contra el cual comparar.
   */
  minPoints?: number;
  /** Múltiplo de la distancia mediana a partir del cual se marca. */
  factor?: number;
  /** Piso absoluto: nunca marcar algo más cerca que esto. */
  minKm?: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Marca los puntos que quedaron lejos de todos los demás.
 *
 * Es la red que atrapa el error más caro y más silencioso del geocoding
 * masivo: "Santiago" sin país que aterriza en Santiago de Cuba, o una
 * calle homónima en otra región. Cada punto individual se ve perfecto —
 * precisión de dirección, alta cobertura— y solo mirando el conjunto se
 * nota que uno está a 6.000 km del resto.
 *
 * Usa la **mediana** y no el promedio a propósito: unos pocos disparates
 * arrastran el promedio hasta que dejan de parecer disparates, que es
 * exactamente lo contrario de lo que se busca.
 */
export function detectOutliers(
  points: Array<{ id: string; lat: number; lng: number }>,
  opts: OutlierOptions = {},
): Map<string, number> {
  const { minPoints = 5, factor = 10, minKm = 100 } = opts;
  const out = new Map<string, number>();
  if (points.length < minPoints) return out;

  const center = {
    lat: median(points.map((p) => p.lat)),
    lng: median(points.map((p) => p.lng)),
  };
  const distances = points.map((p) => haversineMeters(p, center) / 1000);
  const threshold = Math.max(median(distances) * factor, minKm);

  points.forEach((p, i) => {
    if (distances[i] > threshold) out.set(p.id, Math.round(distances[i]));
  });
  return out;
}

/**
 * Aplica la detección de outliers sobre resultados ya clasificados.
 *
 * Corre al final del lote, no fila por fila: hasta no tener el conjunto no
 * se sabe dónde está el grueso de las direcciones. Un `ok` puede pasar a
 * `uncertain` acá, que es todo el punto.
 */
export function applyOutliers(results: BatchResultRow[], opts?: OutlierOptions): BatchResultRow[] {
  const points = results
    .filter((r) => r.value && (r.status === "ok" || r.status === "uncertain"))
    .map((r) => ({ id: r.row.id, lat: r.value!.lat, lng: r.value!.lng }));

  const outliers = detectOutliers(points, opts);
  if (outliers.size === 0) return results;

  return results.map((r) => {
    const km = outliers.get(r.row.id);
    if (km === undefined || r.issues.some((i) => i.code === "far_from_batch")) return r;
    return {
      ...r,
      status: "uncertain",
      issues: [...r.issues, { code: "far_from_batch", detail: `${km} km` }],
    };
  });
}

// ---------- resumen ----------

export interface BatchSummary {
  total: number;
  ok: number;
  uncertain: number;
  failed: number;
  corrected: number;
  pending: number;
}

export function summarize(results: BatchResultRow[]): BatchSummary {
  const summary: BatchSummary = { total: results.length, ok: 0, uncertain: 0, failed: 0, corrected: 0, pending: 0 };
  for (const r of results) summary[r.status] += 1;
  return summary;
}

/** ¿Este código corresponde a un fallo y no a una duda? */
export function isFailure(code: IssueCode): boolean {
  return FAILURE_CODES.has(code);
}

// ---------- cómo conviene revisar una fila ----------

export type CorrectionMode =
  /** Mostrar el punto en el mapa para confirmarlo o moverlo. */
  | "map"
  /** Empezar por el buscador: lo que hay no sirve como punto de partida. */
  | "search";

/**
 * Cuando el geocoder encontró **otro lugar**, no uno impreciso. Abrir el
 * mapa con el pin plantado ahí sería invitar a confirmar un error de un
 * clic.
 */
const WRONG_PLACE: ReadonlySet<IssueCode> = new Set<IssueCode>(["street_mismatch", "weak_match"]);

/**
 * Con qué pantalla conviene abrir la revisión de una fila.
 *
 * La distinción sale de que **no todas las inciertas son iguales**:
 *
 * - Si el punto está en la calle correcta y solo le falta precisión
 *   (`no_house_number`, `number_mismatch`, `zone_only`) o está donde no
 *   corresponde (`outside_admin_area`, `far_from_batch`), lo más rápido es
 *   verlo en el mapa: confirmar o arrastrar el pin unos metros. Medido con
 *   direcciones reales: dos de cada tres se resolvían con un solo clic.
 * - Si probablemente encontró otro lugar, o no encontró nada, el mapa no
 *   ayuda y hay que volver a buscar.
 *
 * Abrir siempre en el buscador —como se hacía antes— tira a la basura el
 * trabajo que el sistema ya hizo y obliga a reescribir una dirección que ya
 * estaba bien.
 */
export function correctionMode(result: BatchResultRow): CorrectionMode {
  if (!result.value) return "search";
  if (result.issues.some((issue) => WRONG_PLACE.has(issue.code))) return "search";
  return "map";
}
