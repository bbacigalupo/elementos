import { timingSafeEqual } from "./keys.ts";
import type { PublicBatchJob, StoredRow } from "./types.ts";

/**
 * Webhooks firmados: cómo el sistema externo se entera de que un trabajo
 * cambió de estado —o de que alguien corrigió una fila por un link— sin
 * tener que hacer polling.
 *
 * Firmados con HMAC-SHA256 sobre el cuerpo tal cual se envía, mismo
 * principio que ya usan las claves de API y los links de corrección: quien
 * recibe puede verificar que el webhook salió de acá y no lo inventó
 * cualquiera que le haya adivinado la URL.
 *
 * **Decisión tomada, no ideal**: un solo secreto por despliegue, no uno por
 * tenant — igual que ya hace `correctionLinks.secret`. Evita resolver "a
 * cuál de las claves de un tenant pertenece este secreto" cuando un tenant
 * puede tener varias. Si algún día hace falta rotar o revocar el secreto
 * de un cliente sin afectar a los demás, eso pide un secreto por tenant;
 * queda anotado como mejora futura, no bloqueante para tener webhooks.
 */

export interface WebhookConfig {
  secret: string;
  /** Reintentos ante una entrega fallida (red, o el receptor respondió 5xx). */
  retries?: number;
  /** Espera base entre reintentos; crece exponencial. */
  retryDelayMs?: number;
}

export type WebhookEventType = "batch.done" | "batch.paused" | "batch.failed" | "batch.row_corrected";

export interface WebhookEvent {
  type: WebhookEventType;
  /**
   * ISO 8601 de cuándo se generó este ENVÍO — no necesariamente cuándo pasó
   * el evento, que puede ser un poco antes si hubo reintentos.
   */
  createdAt: string;
  tenantId: string;
  job: PublicBatchJob;
  /** Solo presente en `batch.row_corrected`. */
  row?: StoredRow;
}

export interface WebhookDeliveryResult {
  delivered: boolean;
  status?: number;
  /** Motivo del fallo, si `delivered` es `false`. */
  error?: string;
  attempts: number;
}

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // Cast por la misma discrepancia de tipos de `Uint8Array` que ya se
  // documentó en correction-links.ts — mismo dato en tiempo de ejecución.
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body) as BufferSource);
  return hexEncode(new Uint8Array(signature));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Entrega un webhook, con reintentos ante una falla de red o una respuesta
 * 5xx del receptor. Un 4xx no se reintenta — significa que el receptor
 * rechazó la petición tal como está, y repetirla no cambia nada.
 *
 * **Nunca lanza.** Una entrega fallida no debe interrumpir ni hacer fallar
 * el procesamiento del trabajo que la originó: es una notificación, no
 * parte de la operación en sí. Quien llama decide qué hacer con el
 * resultado — típicamente, solo registrarlo.
 */
export async function sendWebhook(
  config: WebhookConfig,
  url: string,
  event: WebhookEvent,
): Promise<WebhookDeliveryResult> {
  const { retries = 2, retryDelayMs = 1000 } = config;
  const body = JSON.stringify(event);
  const signature = await hmacHex(config.secret, body);

  let attempts = 0;
  let lastError = "";
  for (;;) {
    attempts += 1;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AllRide-Signature": `sha256=${signature}`,
          "X-AllRide-Event": event.type,
        },
        body,
      });
      if (res.ok) return { delivered: true, status: res.status, attempts };
      if (res.status < 500 || attempts > retries) {
        return { delivered: false, status: res.status, error: `respondió ${res.status}`, attempts };
      }
      lastError = `respondió ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempts > retries) return { delivered: false, error: lastError, attempts };
    }
    await delay(retryDelayMs * 2 ** (attempts - 1));
  }
}

/**
 * Verifica la firma de un webhook recibido — el lado de quien lo consume,
 * no de quien lo envía. Se documenta y exporta acá para que la referencia
 * de cómo verificar viva junto a cómo se firma, en vez de que cada
 * integración tenga que reconstruirlo mirando el header a ciegas.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  signatureHeader: string | null,
): Promise<boolean> {
  const match = signatureHeader?.match(/^sha256=([0-9a-f]+)$/i);
  if (!match) return false;
  const expected = await hmacHex(secret, body);
  return timingSafeEqual(expected, match[1].toLowerCase());
}

/** Qué evento corresponde a cómo terminó un trabajo, o `null` si ese estado no se avisa (`pending`/`running`/`cancelled`). */
export function eventTypeForJobStatus(status: PublicBatchJob["status"]): WebhookEventType | null {
  if (status === "done") return "batch.done";
  if (status === "paused") return "batch.paused";
  if (status === "failed") return "batch.failed";
  return null;
}
