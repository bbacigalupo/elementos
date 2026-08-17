import { useMemo, useState } from "react";
import {
  createPhotonProvider,
  directClient,
  httpClient,
  type BatchRunResult,
  type TileThemeName,
} from "@allride/geo-core";
import { AddressBatch } from "@allride/address-batch";
import { ZONES } from "./zonas.ts";

/**
 * Playground de <AddressBatch>. Los controles de la izquierda replican las
 * decisiones que toma quien integra el elemento —tope de filas, ritmo,
 * concurrencia— porque son justamente las que cambian entre una herramienta
 * pública gratuita y una interna.
 */

type Transport = "proxy" | "direct";

/** Topes de ejemplo, uno por tipo de despliegue. */
const LIMITS: Array<{ value: string; label: string; maxRows?: number }> = [
  { value: "100", label: "100 (herramienta pública gratuita)", maxRows: 100 },
  { value: "1000", label: "1.000 (cliente autenticado)", maxRows: 1000 },
  { value: "sin", label: "Sin tope (uso interno)" },
];

/** Ritmos reales de los proveedores con los que se puede correr esto. */
const PACES: Array<{ value: string; label: string; minIntervalMs: number; concurrency: number }> = [
  { value: "locationiq", label: "LocationIQ free (2 por segundo)", minIntervalMs: 500, concurrency: 3 },
  { value: "nominatim", label: "Nominatim (1 por segundo)", minIntervalMs: 1000, concurrency: 1 },
  { value: "libre", label: "Sin freno (para probar la UI)", minIntervalMs: 0, concurrency: 6 },
];

const MAP_THEMES: Array<{ value: TileThemeName; label: string }> = [
  { value: "carto-positron", label: "CARTO Positron (limpio, sin POIs)" },
  { value: "carto-voyager", label: "CARTO Voyager (moderno, con contexto)" },
  { value: "carto-dark", label: "CARTO Dark (modo oscuro)" },
  { value: "osm", label: "OpenStreetMap estándar" },
];

const EJEMPLOS: Record<string, { label: string; text: string }> = {
  mezcla: {
    label: "Mezcla: exitosas, inciertas y fallidas",
    text: [
      "Av. Providencia 1234, Providencia",
      "Av. Grecia 3000, Ñuñoa",
      "Av. Libertador Bernardo O'Higgins 1449, Santiago",
      "Pedro de Valdivia 290, Providencia",
      "Calle que no existe 99999, Nowhere",
      "Apoquindo 4501, Las Condes",
      "Av. Vicuña Mackenna 4860, Macul",
      "Los Leones 220, Providencia",
      "Santiago",
    ].join("\n"),
  },
  excel: {
    label: "Pegado de Excel (columnas con tabulador)",
    text: [
      "Nombre\tCalle\tNúmero\tComuna",
      "Ana Pérez\tAv. Providencia\t1234\tProvidencia",
      "Luis Rojas\tAv. Grecia\t1700\tPeñalolén",
      "Carla Díaz\tApoquindo\t4501\tLas Condes",
      "Jorge Soto\tAv. Vicuña Mackenna\t4860\tMacul",
    ].join("\n"),
  },
  duplicadas: {
    label: "Con direcciones repetidas",
    text: [
      "Av. Providencia 1234, Providencia",
      "AV. PROVIDENCIA 1234, PROVIDENCIA",
      "av providencia 1234, providencia",
      "Apoquindo 4501, Las Condes",
      "Apoquindo 4501, Las Condes",
    ].join("\n"),
  },
};

export function BatchDemo() {
  const [transport, setTransport] = useState<Transport>("proxy");
  const [zoneKey, setZoneKey] = useState("santiago");
  const [limitKey, setLimitKey] = useState("100");
  const [paceKey, setPaceKey] = useState("locationiq");
  const [mapTheme, setMapTheme] = useState<TileThemeName>("carto-positron");
  const [last, setLast] = useState<BatchRunResult | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const client = useMemo(
    () => (transport === "proxy" ? httpClient("/api/geo") : directClient(createPhotonProvider())),
    [transport],
  );

  const limit = LIMITS.find((l) => l.value === limitKey)!;
  const pace = PACES.find((p) => p.value === paceKey)!;
  const zone = ZONES[zoneKey];

  function reiniciar(apply: () => void) {
    apply();
    setLast(null);
    setResetKey((k) => k + 1);
  }

  return (
    <div className="demo-columns">
      <aside className="demo-controls">
        <h2>Configuración</h2>

        <label className="demo-control">
          <span>Transporte / proveedor</span>
          <select
            value={transport}
            onChange={(e) => reiniciar(() => setTransport(e.target.value as Transport))}
          >
            <option value="proxy">Proxy HTTP (/api/geo → Photon o LocationIQ)</option>
            <option value="direct">Directo desde el navegador (Photon)</option>
          </select>
        </label>

        <label className="demo-control">
          <span>Zona de búsqueda (bias)</span>
          <select value={zoneKey} onChange={(e) => reiniciar(() => setZoneKey(e.target.value))}>
            {Object.entries(ZONES).map(([key, z]) => (
              <option key={key} value={key}>
                {z.label}
              </option>
            ))}
          </select>
        </label>

        <label className="demo-control">
          <span>Tope de direcciones</span>
          <select value={limitKey} onChange={(e) => reiniciar(() => setLimitKey(e.target.value))}>
            {LIMITS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="demo-control">
          <span>Ritmo del proveedor</span>
          <select value={paceKey} onChange={(e) => reiniciar(() => setPaceKey(e.target.value))}>
            {PACES.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        <label className="demo-control">
          <span>Estilo del mapa</span>
          <select value={mapTheme} onChange={(e) => setMapTheme(e.target.value as TileThemeName)}>
            {MAP_THEMES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="demo-control">
          <legend>Ejemplos para pegar</legend>
          {Object.entries(EJEMPLOS).map(([key, ejemplo]) => (
            <button
              key={key}
              type="button"
              className="demo-example"
              onClick={() => void navigator.clipboard.writeText(ejemplo.text)}
              title="Copia el ejemplo al portapapeles para pegarlo en el elemento"
            >
              {ejemplo.label}
            </button>
          ))}
        </fieldset>
      </aside>

      <main className="demo-main">
        <div className="demo-card">
          <AddressBatch
            key={`${transport}-${zoneKey}-${limitKey}-${paceKey}-${resetKey}`}
            client={client}
            bias={zone.bias}
            maxRows={limit.maxRows}
            concurrency={pace.concurrency}
            minIntervalMs={pace.minIntervalMs}
            map={{ theme: mapTheme }}
            storageKey="elementos-demo-lote"
            onComplete={setLast}
          />
        </div>

        <div className="demo-output">
          <h2>Resultado del lote</h2>
          {last ? (
            <pre>
              {JSON.stringify(
                {
                  resumen: last.summary,
                  cancelado: last.cancelled,
                  consultasAlProveedor: last.queries,
                  duracionSegundos: Math.round(last.elapsedMs / 100) / 10,
                  primeras3: last.results.slice(0, 3).map((r) => ({
                    fila: r.row.index,
                    ingresada: r.row.raw,
                    estado: r.status,
                    motivos: r.issues.map((i) => i.code),
                    lat: r.value?.lat,
                    lng: r.value?.lng,
                  })),
                },
                null,
                2,
              )}
            </pre>
          ) : (
            <p className="demo-empty">Aún no se ha procesado ningún lote.</p>
          )}
        </div>
      </main>
    </div>
  );
}
