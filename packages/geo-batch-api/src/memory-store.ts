import type { BatchStore } from "./store.ts";
import type {
  ApiKeyRecord,
  BatchJob,
  ListJobsOptions,
  ListRowsOptions,
  ListRowsResult,
  StoredRow,
} from "./types.ts";

/**
 * Store en memoria, de referencia.
 *
 * Sirve para desarrollo, para los tests y para que quien vaya a implementar
 * el suyo tenga un comportamiento contra el cual comparar. **No sirve para
 * producción**: se pierde al reiniciar y no se comparte entre instancias,
 * así que dos procesos verían trabajos distintos y los links de corrección
 * dejarían de resolver al azar.
 *
 * Implementa la misma semántica que se le pide a un store real, incluida la
 * atomicidad de `claimNextJob` — que en JavaScript sale gratis por ser de
 * un solo hilo, y en SQL hay que escribirla a mano (ver el README).
 */
export interface MemoryStore extends BatchStore {
  /**
   * Registra una clave de API. Vive fuera de `BatchStore` porque crear
   * claves es administración, no operación de la API: en un despliegue real
   * lo hace un panel o un script contra la base, nunca este paquete.
   */
  addApiKey(record: ApiKeyRecord): void;
  /** Estado interno, para inspeccionarlo en los tests. */
  snapshot(): { jobs: number; rows: number; keys: number };
}

export function createMemoryStore(): MemoryStore {
  const jobs = new Map<string, BatchJob>();
  const rows = new Map<string, StoredRow[]>();
  const keys = new Map<string, ApiKeyRecord>();
  const usage: Array<{ tenantId: string; queries: number; at: number }> = [];

  /** Copia defensiva: quien lea no debe poder mutar lo guardado. */
  const clone = <T>(value: T): T => structuredClone(value);

  function ownedJob(tenantId: string, jobId: string): BatchJob | null {
    const job = jobs.get(jobId);
    return job && job.tenantId === tenantId ? job : null;
  }

  return {
    async createJob(job, jobRows) {
      if (jobs.has(job.id)) throw new Error(`El trabajo ${job.id} ya existe`);
      // Trabajo y filas entran juntos: un trabajo sin filas es un trabajo
      // que el worker toma y no puede procesar.
      jobs.set(job.id, clone(job));
      rows.set(job.id, clone(jobRows));
    },

    async getJob(tenantId, jobId) {
      const job = ownedJob(tenantId, jobId);
      return job ? clone(job) : null;
    },

    async listJobs(tenantId, opts: ListJobsOptions = {}) {
      const { status, limit = 50, offset = 0 } = opts;
      return [...jobs.values()]
        .filter((j) => j.tenantId === tenantId && (!status || status.includes(j.status)))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(offset, offset + limit)
        .map(clone);
    },

    async findByIdempotencyKey(tenantId, key) {
      const job = [...jobs.values()].find(
        (j) => j.tenantId === tenantId && j.idempotencyKey === key,
      );
      return job ? clone(job) : null;
    },

    async updateJob(jobId, patch) {
      const job = jobs.get(jobId);
      if (!job) return;
      // `id` y `tenantId` no se parchean: cambiarlos movería un trabajo de
      // un cliente a otro, que es exactamente lo que el aislamiento impide.
      const { id: _id, tenantId: _tenant, ...resto } = patch;
      jobs.set(jobId, { ...job, ...clone(resto) });
    },

    async deleteJob(tenantId, jobId) {
      if (!ownedJob(tenantId, jobId)) return false;
      jobs.delete(jobId);
      rows.delete(jobId);
      return true;
    },

    async listRows(tenantId, jobId, opts: ListRowsOptions = {}) {
      if (!ownedJob(tenantId, jobId)) return { rows: [], total: 0 };
      const { status, limit = 100, offset = 0 } = opts;
      const todas = (rows.get(jobId) ?? []).filter((r) => !status || status.includes(r.status));
      const result: ListRowsResult = {
        total: todas.length,
        rows: todas
          .sort((a, b) => a.row.index - b.row.index)
          .slice(offset, offset + limit)
          .map(clone),
      };
      return result;
    },

    async getRow(tenantId, jobId, rowId) {
      if (!ownedJob(tenantId, jobId)) return null;
      const row = (rows.get(jobId) ?? []).find((r) => r.row.id === rowId);
      return row ? clone(row) : null;
    },

    async saveRows(nuevas) {
      for (const fila of nuevas) {
        const actuales = rows.get(fila.jobId);
        if (!actuales) continue;
        const i = actuales.findIndex((r) => r.row.id === fila.row.id);
        if (i >= 0) actuales[i] = clone(fila);
        else actuales.push(clone(fila));
      }
    },

    async claimNextJob(workerId, leaseMs) {
      const ahora = Date.now();
      const candidato = [...jobs.values()]
        .filter(
          (j) =>
            j.status === "pending" ||
            // Rescate: un worker que se cayó dejó su arriendo vencido, o un
            // trabajo pausado por cuota/caída ya puede reintentarse.
            ((j.status === "running" || j.status === "paused") &&
              (!j.leaseUntil || Date.parse(j.leaseUntil) < ahora)),
        )
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (!candidato) return null;

      candidato.status = "running";
      candidato.workerId = workerId;
      candidato.leaseUntil = new Date(ahora + leaseMs).toISOString();
      candidato.startedAt ??= new Date(ahora).toISOString();
      return clone(candidato);
    },

    async heartbeat(jobId, workerId, leaseMs) {
      const job = jobs.get(jobId);
      // Si otro worker se lo quedó, este debe soltarlo: dos workers sobre el
      // mismo lote gastan la cuota dos veces.
      if (!job || job.workerId !== workerId) return false;
      job.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
      return true;
    },

    async findApiKeyByHash(hash) {
      const key = [...keys.values()].find((k) => k.keyHash === hash);
      return key ? clone(key) : null;
    },

    async touchApiKey(id, at) {
      const key = keys.get(id);
      if (key) key.lastUsedAt = at.toISOString();
    },

    async recordUsage(tenantId, queries, at) {
      if (queries <= 0) return;
      usage.push({ tenantId, queries, at: at.getTime() });
    },

    async usageSince(tenantId, since) {
      const desde = since.getTime();
      return usage
        .filter((u) => u.tenantId === tenantId && u.at >= desde)
        .reduce((total, u) => total + u.queries, 0);
    },

    async purgeExpired(now) {
      const limite = now.getTime();
      let borrados = 0;
      for (const [id, job] of jobs) {
        if (Date.parse(job.expiresAt) <= limite) {
          jobs.delete(id);
          rows.delete(id);
          borrados += 1;
        }
      }
      return borrados;
    },

    addApiKey(record) {
      keys.set(record.id, clone(record));
    },

    snapshot() {
      return {
        jobs: jobs.size,
        rows: [...rows.values()].reduce((n, r) => n + r.length, 0),
        keys: keys.size,
      };
    },

    async purgeTenant(tenantId) {
      let borrados = 0;
      for (const [id, job] of jobs) {
        if (job.tenantId === tenantId) {
          jobs.delete(id);
          rows.delete(id);
          borrados += 1;
        }
      }
      for (const [id, key] of keys) {
        if (key.tenantId === tenantId) keys.delete(id);
      }
      return borrados;
    },
  };
}

