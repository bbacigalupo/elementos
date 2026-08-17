import { useState } from "react";
import { httpClient } from "@allride/geo-core";
import { CorrectionPage } from "@allride/address-batch";
import { ZONES } from "./zonas.ts";

/**
 * Playground de `<CorrectionPage>` — lo que abre una persona SIN clave de
 * API al hacer clic en un link de corrección firmado (pasos 13-18).
 *
 * Con `?token=…` en la URL, es exactamente esa página. Sin él, ofrece
 * generar un link de prueba de verdad: crea un trabajo por la API (con una
 * clave, como haría un sistema externo), emite un link firmado para su
 * fila, y navega ahí — así se ve el flujo completo, no una simulación.
 */

const BIAS = ZONES.santiago.bias;
const client = httpClient("/api/geo");

export function CorrectionPageDemo() {
  const token = new URLSearchParams(window.location.search).get("token");

  if (token) {
    return (
      <div className="demo-card">
        <CorrectionPage token={token} apiBaseUrl="/v1/corrections" client={client} bias={BIAS} />
      </div>
    );
  }

  return <LinkGenerator />;
}

function LinkGenerator() {
  const [estado, setEstado] = useState<"listo" | "creando" | "error">("listo");
  const [error, setError] = useState<string | null>(null);

  async function crear() {
    setEstado("creando");
    setError(null);
    try {
      const { apiKey } = await fetch("/api/demo-key").then((r) => r.json());
      const auth = { Authorization: `Bearer ${apiKey}` };

      const creado = await fetch("/v1/batches", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          // A propósito una altura que no existe: da una fila incierta,
          // que es justo el caso que un link de corrección tiene sentido.
          addresses: ["Av. Apoquindo 99999, Las Condes"],
          bias: { country: "CL" },
          sync: true,
        }),
      }).then((r) => r.json());
      if (!creado.ok) throw new Error(creado.detail ?? creado.error ?? "no se pudo crear el trabajo");

      const fila = creado.rows[0];
      const link = await fetch(`/v1/batches/${creado.job.id}/rows/${fila.row.id}/correction-link`, {
        method: "POST",
        headers: auth,
      }).then((r) => r.json());
      if (!link.ok) throw new Error(link.detail ?? link.error ?? "no se pudo emitir el link");

      // Navega de verdad: lo que sigue lo atiende `<CorrectionPage>` leyendo
      // el token de la URL, sin ninguna clave de API de por medio — es
      // exactamente lo que vería la persona que recibe el link.
      window.location.href = `?token=${link.token}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEstado("error");
    }
  }

  return (
    <div className="demo-card arb-root">
      <p className="demo-empty">
        Simula lo que hace un sistema externo: crea un trabajo con una clave de API (dirección a
        propósito difícil de geocodificar) y emite un link de corrección firmado para su única fila.
        Al abrirlo se ve exactamente lo que vería quien recibe el link — sin clave de API de por
        medio, solo con el token.
      </p>
      <button
        type="button"
        className="arb-button arb-button-primary"
        onClick={() => void crear()}
        disabled={estado === "creando"}
      >
        {estado === "creando" ? "Creando…" : "Crear dirección de prueba y generar link"}
      </button>
      {error && <p className="arb-notice arb-notice-error">{error}</p>}
    </div>
  );
}
