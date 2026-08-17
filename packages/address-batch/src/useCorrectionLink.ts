import { useCallback, useEffect, useState } from "react";
import type { BatchResultRow, LocationValue } from "@allride/geo-core";

/**
 * Estado de una página de corrección por link — sin clave de API, el
 * propio token es la credencial. Habla con los endpoints públicos de
 * `@allride/geo-batch-api` (`createCorrectionHandlers`): `GET` para traer
 * la fila tal como está hoy, `POST` para aplicar la corrección.
 */

export type CorrectionLinkPhase = "loading" | "ready" | "submitting" | "done" | "error";

export interface CorrectionLinkError {
  /** El código que devolvió el servidor (`expired_token`, `not_found`…) o `network_error` si no llegó a responder. */
  code: string;
  detail?: string;
}

export interface UseCorrectionLinkOptions {
  token: string;
  /** Base del endpoint público de corrección, SIN el token al final — ej. "https://api.miapp.cl/v1/corrections". */
  apiBaseUrl: string;
}

export interface UseCorrectionLinkResult {
  phase: CorrectionLinkPhase;
  /** La fila tal como está hoy (o como quedó tras corregir). `null` mientras carga o si el link no sirve. */
  result: BatchResultRow | null;
  error: CorrectionLinkError | null;
  submit: (value: LocationValue) => Promise<void>;
  /** Reintenta la carga inicial — sirve tras un error de red, no tras un token vencido o inválido. */
  retry: () => void;
}

function endpointUrl(apiBaseUrl: string, token: string): string {
  return `${apiBaseUrl.replace(/\/$/, "")}/${token}`;
}

interface Envelope {
  ok: boolean;
  error?: string;
  detail?: string;
  row?: BatchResultRow;
}

async function readEnvelope(res: Response): Promise<Envelope | null> {
  try {
    return (await res.json()) as Envelope;
  } catch {
    return null;
  }
}

export function useCorrectionLink({ token, apiBaseUrl }: UseCorrectionLinkOptions): UseCorrectionLinkResult {
  const [phase, setPhase] = useState<CorrectionLinkPhase>("loading");
  const [result, setResult] = useState<BatchResultRow | null>(null);
  const [error, setError] = useState<CorrectionLinkError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let vivo = true;
    setPhase("loading");
    setError(null);

    fetch(endpointUrl(apiBaseUrl, token))
      .then(async (res) => {
        const body = await readEnvelope(res);
        if (!vivo) return;
        if (!res.ok || !body?.ok || !body.row) {
          setError({ code: body?.error ?? "unknown", detail: body?.detail });
          setPhase("error");
          return;
        }
        setResult(body.row);
        setPhase("ready");
      })
      .catch(() => {
        if (vivo) {
          setError({ code: "network_error" });
          setPhase("error");
        }
      });

    return () => {
      vivo = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, apiBaseUrl, attempt]);

  const submit = useCallback(
    async (value: LocationValue) => {
      setPhase("submitting");
      setError(null);
      try {
        const res = await fetch(endpointUrl(apiBaseUrl, token), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(value),
        });
        const body = await readEnvelope(res);
        if (!res.ok || !body?.ok || !body.row) {
          setError({ code: body?.error ?? "unknown", detail: body?.detail });
          // Vuelve al formulario, no a "loading": el punto que la persona
          // acaba de elegir sigue a la vista, listo para reintentar sin
          // tener que buscar la dirección de nuevo.
          setPhase("ready");
          return;
        }
        setResult(body.row);
        setPhase("done");
      } catch {
        setError({ code: "network_error" });
        setPhase("ready");
      }
    },
    [apiBaseUrl, token],
  );

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { phase, result, error, submit, retry };
}
