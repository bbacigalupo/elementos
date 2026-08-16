import type {
  BatchResultRow,
  BatchSummary,
  GeoBias,
} from "@allride/geo-core";

/**
 * Tipos persistidos de la API de geocodificación masiva.
 *
 * Todo lo que se guarda son **domicilios de personas**. Eso condiciona el
 * diseño en tres puntos que no son negociables y aparecen repetidos acá:
 * cada trabajo nace con fecha de vencimiento, cada lectura que sirve a una
 * petición lleva el `tenantId` en la firma (aislamiento por construcción,
 * no por disciplina) y las claves de API se guardan solo como hash.
 */

export type JobStatus =
  /** Aceptado, esperando que un worker lo tome. */
  | "pending"
  /** Un worker lo está procesando. */
  | "running"
  | "done"
  | "cancelled"
  /**
   * Se detuvo solo a mitad de camino, y no por culpa del trabajo ni del
   * cliente: cuota diaria agotada con el proveedor, o el proveedor caído
   * (ver `BatchStopReason` en `@allride/geo-core`). Las filas que
   * alcanzaron a procesarse quedan guardadas; las que no, en `pending`. Se
   * retoma solo — `leaseUntil` dice cuándo, y `claimNextJob` lo rescata
   * igual que a un trabajo `running` con el arriendo vencido.
   */
  | "paused"
  /** El worker no pudo terminarlo por algo que no se va a arreglar solo (ej. credencial rechazada). El detalle va en `error`. */
  | "failed";

export interface BatchJob {
  id: string;
  /** Cliente dueño del trabajo. Ninguna lectura cruza este límite. */
  tenantId: string;
  status: JobStatus;
  /** ISO 8601. */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * Cuándo deja de existir este trabajo. No es una anotación: `purgeExpired`
   * lo borra, y borrarlo invalida de inmediato todos sus links de corrección.
   */
  expiresAt: string;
  bias: GeoBias;
  /** Encabezados del archivo original, para devolver las columnas del cliente. */
  sourceHeaders: string[] | null;
  rowCount: number;
  summary: BatchSummary;
  /**
   * Consultas gastadas contra el proveedor. Es lo que se cobra y lo que se
   * cuenta contra la cuota — no las filas: los duplicados y las
   * coordenadas ya resueltas no cuestan nada y el cliente debe verlo.
   */
  queries: number;
  /** Repetir la misma petición no debe crear un segundo trabajo. */
  idempotencyKey?: string;
  webhookUrl?: string;
  /** Etiqueta libre del cliente, para que reconozca su propio lote. */
  reference?: string;
  error?: string;

  // --- control del worker ---
  /** Worker que lo tiene tomado. */
  workerId?: string;
  /**
   * Hasta cuándo vale ese arriendo. Si vence, otro worker puede reclamarlo:
   * es lo que evita que un proceso caído deje un lote colgado para siempre.
   */
  leaseUntil?: string;
}

/**
 * Una fila del trabajo, tal como se guarda.
 *
 * Extiende el `BatchResultRow` que ya produce el motor en vez de definir
 * una forma paralela: si fueran dos estructuras distintas, tarde o
 * temprano una diría algo que la otra no.
 */
export interface StoredRow extends BatchResultRow {
  jobId: string;
  /** ISO 8601. */
  updatedAt: string;
}

// ---------- claves de API ----------

export type ApiScope = "batches:write" | "batches:read" | "corrections:write";

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  /**
   * SHA-256 en hexadecimal de la clave. **La clave en claro no se guarda
   * nunca**: se muestra una sola vez al crearla y de ahí en adelante solo
   * existe del lado del cliente. Una filtración de la base no entrega
   * acceso a nada.
   */
  keyHash: string;
  /** Nombre para reconocerla en un panel ("ERP de nóminas", "pruebas"). */
  name: string;
  scopes: ApiScope[];
  /**
   * Tope de consultas al proveedor por día. `null` es sin tope, y es lo
   * correcto para las claves internas de AllRide.
   */
  dailyQuota: number | null;
  createdAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
}

// ---------- consultas al store ----------

export interface ListRowsOptions {
  /** Solo estos estados. Sin valor, todos. */
  status?: Array<StoredRow["status"]>;
  limit?: number;
  offset?: number;
}

export interface ListRowsResult {
  rows: StoredRow[];
  /** Total que cumple el filtro, no el de la página. */
  total: number;
}

export interface ListJobsOptions {
  status?: JobStatus[];
  limit?: number;
  offset?: number;
}

// ---------- forma pública ----------

/** `BatchJob` sin lo que es solo bookkeeping interno del worker. */
export type PublicBatchJob = Omit<BatchJob, "workerId" | "leaseUntil">;

/**
 * El trabajo tal como lo ve alguien de afuera: en la respuesta de los
 * endpoints, y en el cuerpo de un webhook. Un mismo punto para las dos
 * cosas — antes de esto cada lugar armaba su propia copia sin `workerId`
 * ni `leaseUntil`, y nada garantizaba que las tres copias dijeran lo mismo.
 */
export function toPublicJob(job: BatchJob): PublicBatchJob {
  const { workerId: _workerId, leaseUntil: _leaseUntil, ...publico } = job;
  return publico;
}
