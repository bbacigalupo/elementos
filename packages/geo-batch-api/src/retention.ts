import type { BatchStore } from "./store.ts";

/**
 * Agendar `store.purgeExpired` de verdad. El método ya existe en
 * `BatchStore` desde el primer paso (`store.ts`) — lo que faltaba es la
 * pieza que lo llama con el tiempo, porque un método que nadie invoca no es
 * una política de retención, es una promesa incumplida sobre domicilios de
 * personas.
 *
 * `runRetentionLoop` es la conveniencia para un proceso Node de larga
 * duración, mismo rol que `runWorkerLoop` para el worker — no es la única
 * forma de correrlo: un cron (`node-cron`, Vercel Cron, un job de
 * Kubernetes) que llama `store.purgeExpired(new Date())` una vez por
 * invocación sirve igual y no necesita esto.
 */

export interface RetentionLoopOptions {
  store: BatchStore;
  /** Cada cuánto se purga. Los trabajos viven días (`retentionDays`); purgar cada hora sobra de sobra. */
  intervalMs?: number;
  signal?: AbortSignal;
  onPurge?: (borrados: number) => void;
  onError?: (err: unknown) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Corre `store.purgeExpired` en un intervalo, hasta que se aborte `signal`.
 * Purga una vez al arrancar (no espera el primer intervalo completo) para
 * que un despliegue recién levantado no cargue con trabajos vencidos de
 * antes de que este proceso existiera.
 */
export async function runRetentionLoop(opts: RetentionLoopOptions): Promise<void> {
  const { store, intervalMs = 60 * 60_000, signal, onPurge, onError } = opts;
  while (!signal?.aborted) {
    try {
      const borrados = await store.purgeExpired(new Date());
      onPurge?.(borrados);
    } catch (err) {
      onError?.(err);
    }
    await delay(intervalMs, signal);
  }
}
