import { useMemo, useState } from "react";
import {
  createPhotonProvider,
  directClient,
  httpClient,
  type CaptureMetrics,
  type GeoBias,
  type LocationValue,
} from "@allride/geo-core";
import { AddressInput, type MarkerConfig, type TileThemeName } from "@allride/address-input";
import { COMUNAS_RM, ZONES } from "./zonas.ts";

/**
 * Playground de <AddressInput>. Permite variar transporte, zona de bias y
 * modos habilitados, y muestra el LocationValue + métricas que produce cada
 * captura — lo mismo que recibiría una encuesta o el flujo de viajes.
 *
 * Las constantes de zona y de comunas se exportan porque el playground del
 * elemento masivo usa exactamente las mismas: probar los dos elementos
 * contra zonas distintas escondería diferencias que son del elemento y no
 * de la configuración.
 */

type Transport = "proxy" | "direct";



const MAP_THEMES: Array<{ value: TileThemeName; label: string }> = [
  { value: "carto-positron", label: "CARTO Positron (limpio, sin POIs)" },
  { value: "carto-positron-xl", label: "CARTO Positron XL (nombres 2x, menos detalle)" },
  { value: "carto-voyager", label: "CARTO Voyager (moderno, con contexto)" },
  { value: "carto-dark", label: "CARTO Dark (modo oscuro)" },
  { value: "osm", label: "OpenStreetMap estándar (cargado de POIs)" },
];

const MARKERS: Record<string, { label: string; config: MarkerConfig }> = {
  logoAllride: { label: "Pin AllRide (logo)", config: {} },
  logoNavy: {
    label: "Pin AllRide navy",
    config: { color: "#20074F" },
  },
  puntoSimple: { label: "Punto simple (sin marca)", config: { variant: "dot" } },
  planoSinEfectos: {
    label: "Logo plano (sin sombra ni animación)",
    config: { shadow: false, animate: false },
  },
};

export function AddressInputDemo() {
  const [transport, setTransport] = useState<Transport>("proxy");
  const [zoneKey, setZoneKey] = useState("santiago");
  const [modes, setModes] = useState({ search: true, map: true, gps: true, coords: true });
  const [mapTheme, setMapTheme] = useState<TileThemeName>("carto-positron");
  const [markerKey, setMarkerKey] = useState("logoAllride");
  const [pedirComuna, setPedirComuna] = useState(false);
  const [privacidad, setPrivacidad] = useState(false);
  const [captured, setCaptured] = useState<LocationValue | null>(null);
  const [metrics, setMetrics] = useState<CaptureMetrics | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const client = useMemo(
    () =>
      transport === "proxy"
        ? httpClient("/api/geo")
        : directClient(createPhotonProvider()),
    [transport],
  );

  const zone = ZONES[zoneKey];

  function toggleMode(name: keyof typeof modes) {
    setModes((m) => ({ ...m, [name]: !m[name] }));
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
              onChange={(e) => {
                setTransport(e.target.value as Transport);
                setResetKey((k) => k + 1);
              }}
            >
              <option value="proxy">Proxy HTTP (/api/geo → Photon o LocationIQ)</option>
              <option value="direct">Directo desde el navegador (Photon)</option>
            </select>
          </label>

          <label className="demo-control">
            <span>Zona de búsqueda (bias)</span>
            <select
              value={zoneKey}
              onChange={(e) => {
                setZoneKey(e.target.value);
                setResetKey((k) => k + 1);
              }}
            >
              {Object.entries(ZONES).map(([key, z]) => (
                <option key={key} value={key}>
                  {z.label}
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

          <label className="demo-control">
            <span>Marcador</span>
            <select value={markerKey} onChange={(e) => setMarkerKey(e.target.value)}>
              {Object.entries(MARKERS).map(([key, m]) => (
                <option key={key} value={key}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="demo-control">
            <legend>Opciones de la encuesta</legend>
            <label className="demo-check">
              <input
                type="checkbox"
                checked={pedirComuna}
                onChange={() => {
                  setPedirComuna((v) => !v);
                  setResetKey((k) => k + 1);
                }}
              />
              <span>Pedir comuna (prevalece sobre el geocoder)</span>
            </label>
            <label className="demo-check">
              <input type="checkbox" checked={privacidad} onChange={() => setPrivacidad((v) => !v)} />
              <span>Aviso de privacidad</span>
            </label>
          </fieldset>

          <fieldset className="demo-control">
            <legend>Modos habilitados</legend>
            {(Object.keys(modes) as Array<keyof typeof modes>).map((name) => (
              <label key={name} className="demo-check">
                <input type="checkbox" checked={modes[name]} onChange={() => toggleMode(name)} />
                <span>
                  {name === "search"
                    ? "Búsqueda con autocompletado"
                    : name === "map"
                      ? "Marcar en el mapa"
                      : name === "gps"
                        ? "Usar mi ubicación (GPS)"
                        : "Coordenadas manuales"}
                </span>
              </label>
            ))}
          </fieldset>
        </aside>

        <main className="demo-main">
          <div className="demo-card">
            <AddressInput
              key={`${transport}-${zoneKey}-${resetKey}`}
              client={client}
              bias={zone.bias}
              modes={modes}
              map={{ theme: mapTheme, marker: MARKERS[markerKey].config }}
              adminAreas={pedirComuna ? { options: COMUNAS_RM, label: "Comuna", required: true } : undefined}
              minPrecision="street"
              privacyHint={privacidad}
              label="¿Cuál es la dirección?"
              helpText="Escribe y elige una sugerencia, o usa el mapa, tu ubicación o coordenadas."
              onChange={setCaptured}
              onMetrics={setMetrics}
            />
          </div>

          <div className="demo-output">
            <h2>LocationValue capturado</h2>
            {captured ? (
              <pre>{JSON.stringify(captured, null, 2)}</pre>
            ) : (
              <p className="demo-empty">Aún no hay captura confirmada.</p>
            )}
            <h2>Métricas de la captura</h2>
            {metrics ? (
              <pre>{JSON.stringify(metrics, null, 2)}</pre>
            ) : (
              <p className="demo-empty">Se registran al confirmar.</p>
            )}
          </div>
        </main>
    </div>
  );
}
