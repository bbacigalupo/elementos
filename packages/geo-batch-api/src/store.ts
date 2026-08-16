import type {
  ApiKeyRecord,
  BatchJob,
  ListJobsOptions,
  ListRowsOptions,
  ListRowsResult,
  StoredRow,
} from "./types.ts";

/**
 * `BatchStore` — la única pieza que escribe quien despliega esta API.
 *
 * El paquete no trae base de datos a propósito: el monorepo se mantiene sin
 * dependencias y cada despliegue elige su tecnología (Postgres, Supabase,
 * Redis, lo que sea). Acá está el contrato; en el README está el esquema
 * SQL listo para copiar, y `createMemoryStore()` sirve para desarrollo y
 * tests.
 *
 * **Dos reglas que el contrato impone por firma, no por confianza:**
 *
 * 1. Todo método que sirve a una petición de la API recibe `tenantId`. No
 *    existe un `getJob(id)` a secas que un endpoint pueda llamar por
 *    descuido; para leer un trabajo hay que decir de quién es. El
 *    aislamiento entre clientes deja de depender de que alguien se acuerde
 *    de filtrar.
 * 2. Los métodos del worker (`claimNextJob`, `saveRows`, `heartbeat`) no
 *    llevan tenant porque operan sobre un trabajo ya reclamado, que trae el
 *    suyo adentro.
 */
export interface BatchStore {
  // ---------- trabajos ----------

  /**
   * Crea el trabajo y sus filas. **Debe ser atómico**: un trabajo sin filas
   * es un trabajo que el worker toma y no puede procesar, y queda dando
   * vueltas como "running" hasta que vence el arriendo.
   */
  createJob(job: BatchJob, rows: StoredRow[]): Promise<void>;

  getJob(tenantId: string, jobId: string): Promise<BatchJob | null>;

  listJobs(tenantId: string, opts?: ListJobsOptions): Promise<BatchJob[]>;

  /**
   * Busca un trabajo por la clave de idempotencia del cliente. Los sistemas
   * externos reintentan ante un timeout, y sin esto un reintento crearía un
   * segundo lote y cobraría dos veces la misma cuota.
   */
  findByIdempotencyKey(tenantId: string, key: string): Promise<BatchJob | null>;

  updateJob(jobId: string, patch: Partial<BatchJob>): Promise<void>;

  /** Borrado a pedido. Devuelve false si no existía o no era de ese cliente. */
  deleteJob(tenantId: string, jobId: string): Promise<boolean>;

  // ---------- filas ----------

  listRows(tenantId: string, jobId: string, opts?: ListRowsOptions): Promise<ListRowsResult>;

  getRow(tenantId: string, jobId: string, rowId: string): Promise<StoredRow | null>;

  /**
   * Guarda o reemplaza filas. Lo llama el worker mientras avanza, así que
   * conviene que sea un upsert por (jobId, rowId) y no un borrar-e-insertar.
   */
  saveRows(rows: StoredRow[]): Promise<void>;

  // ---------- worker ----------

  /**
   * Toma el siguiente trabajo procesable y lo marca como `running` con un
   * arriendo hasta `now + leaseMs`.
   *
   * **Debe ser atómico entre varios workers.** En Postgres:
   *
   * ```sql
   * UPDATE batch_jobs SET status='running', worker_id=$1, lease_until=$2
   * WHERE id = (
   *   SELECT id FROM batch_jobs
   *   WHERE status='pending'
   *      OR (status IN ('running','paused') AND lease_until < now())
   *   ORDER BY created_at
   *   LIMIT 1 FOR UPDATE SKIP LOCKED
   * ) RETURNING *;
   * ```
   *
   * La condición sobre `running` rescata los trabajos de un worker que se
   * cayó: sin ella, un despliegue a mitad de lote lo deja colgado para
   * siempre. La misma condición sobre `paused` es lo que retoma solo un
   * trabajo que se detuvo por cuota propia o por el proveedor caído — acá
   * `lease_until` no es un arriendo sino "no reclamar antes de esta hora",
   * mismo campo, mismo mecanismo de rescate.
   */
  claimNextJob(workerId: string, leaseMs: number): Promise<BatchJob | null>;

  /**
   * Renueva el arriendo. Devuelve false si otro worker se lo quedó — en ese
   * caso el worker actual debe soltarlo sin escribir nada más, o los dos
   * estarían gastando cuota sobre el mismo lote.
   */
  heartbeat(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;

  // ---------- claves de API ----------

  findApiKeyByHash(hash: string): Promise<ApiKeyRecord | null>;

  touchApiKey(id: string, at: Date): Promise<void>;

  /** Suma consumo del cliente, para la cuota diaria. */
  recordUsage(tenantId: string, queries: number, at: Date): Promise<void>;

  /** Consultas gastadas por el cliente desde un momento dado. */
  usageSince(tenantId: string, since: Date): Promise<number>;

  // ---------- retención ----------

  /**
   * Borra los trabajos vencidos y sus filas. Devuelve cuántos borró.
   *
   * **Hay que agendarlo de verdad.** Una política de retención que no
   * corre no es una política de retención: es una promesa incumplida sobre
   * domicilios de personas. `runRetentionLoop` (`retention.ts`) es la
   * conveniencia para un proceso de larga duración; un cron que llame esto
   * una vez por invocación sirve igual.
   */
  purgeExpired(now: Date): Promise<number>;

  /**
   * Borra todo lo de un cliente — trabajos, filas y sus claves de API.
   * Para cuando lo pidan, y lo van a pedir.
   *
   * **Deliberadamente sin endpoint HTTP en este paquete.** Es irreversible,
   * de alcance total (incluida la clave con la que se autenticaría la
   * propia petición) y no es una operación que un cliente deba poder
   * disparar con una sola llamada Bearer — quien despliegue la conecta a su
   * propio flujo de soporte/borrado (verificación de identidad, ticket,
   * confirmación aparte), no a un endpoint público.
   */
  purgeTenant(tenantId: string): Promise<number>;
}
