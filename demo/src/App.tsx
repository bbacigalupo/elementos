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
import type { AdminAreaOption } from "@allride/geo-core";

/**
 * Playground de <AddressInput>. Permite variar transporte, zona de bias y
 * modos habilitados, y muestra el LocationValue + métricas que produce cada
 * captura — lo mismo que recibiría una encuesta o el flujo de viajes.
 */

type Transport = "proxy" | "direct";

const ZONES: Record<string, { label: string; bias: GeoBias }> = {
  santiago: {
    label: "Santiago, CL",
    bias: { country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 },
  },
  valparaiso: {
    label: "Valparaíso, CL",
    bias: { country: "CL", center: { lat: -33.0472, lng: -71.6127 }, radiusKm: 25 },
  },
  concepcion: {
    label: "Concepción, CL",
    bias: { country: "CL", center: { lat: -36.8201, lng: -73.0444 }, radiusKm: 25 },
  },
  bogota: {
    label: "Bogotá, CO",
    bias: { country: "CO", center: { lat: 4.711, lng: -74.0721 }, radiusKm: 40 },
  },
  paisSolo: {
    label: "Solo país (CL, sin centro)",
    bias: { country: "CL" },
  },
};

/** Comunas de la Región Metropolitana, del mismo catálogo que usa la encuesta. */
const COMUNAS_RM: AdminAreaOption[] = [
  {"id": "cerrillos", "name": "Cerrillos", "parentName": "Región Metropolitana de Santiago"}, {"id": "cerro-navia", "name": "Cerro Navia", "parentName": "Región Metropolitana de Santiago"}, {"id": "conchali", "name": "Conchalí", "parentName": "Región Metropolitana de Santiago"}, {"id": "el-bosque", "name": "El Bosque", "parentName": "Región Metropolitana de Santiago"}, {"id": "estacion-central", "name": "Estación Central", "parentName": "Región Metropolitana de Santiago"}, {"id": "huechuraba", "name": "Huechuraba", "parentName": "Región Metropolitana de Santiago"}, {"id": "independencia", "name": "Independencia", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-cisterna", "name": "La Cisterna", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-florida", "name": "La Florida", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-granja", "name": "La Granja", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-pintana", "name": "La Pintana", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-reina", "name": "La Reina", "parentName": "Región Metropolitana de Santiago"}, {"id": "las-condes", "name": "Las Condes", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-barnechea", "name": "Lo Barnechea", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-espejo", "name": "Lo Espejo", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-prado", "name": "Lo Prado", "parentName": "Región Metropolitana de Santiago"}, {"id": "macul", "name": "Macul", "parentName": "Región Metropolitana de Santiago"}, {"id": "maipu", "name": "Maipú", "parentName": "Región Metropolitana de Santiago"}, {"id": "nunoa", "name": "Ñuñoa", "parentName": "Región Metropolitana de Santiago"}, {"id": "pedro-aguirre-cerda", "name": "Pedro Aguirre Cerda", "parentName": "Región Metropolitana de Santiago"}, {"id": "penalolen", "name": "Peñalolén", "parentName": "Región Metropolitana de Santiago"}, {"id": "providencia", "name": "Providencia", "parentName": "Región Metropolitana de Santiago"}, {"id": "pudahuel", "name": "Pudahuel", "parentName": "Región Metropolitana de Santiago"}, {"id": "quilicura", "name": "Quilicura", "parentName": "Región Metropolitana de Santiago"}, {"id": "quinta-normal", "name": "Quinta Normal", "parentName": "Región Metropolitana de Santiago"}, {"id": "recoleta", "name": "Recoleta", "parentName": "Región Metropolitana de Santiago"}, {"id": "renca", "name": "Renca", "parentName": "Región Metropolitana de Santiago"}, {"id": "santiago", "name": "Santiago", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-joaquin", "name": "San Joaquín", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-miguel", "name": "San Miguel", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-ramon", "name": "San Ramón", "parentName": "Región Metropolitana de Santiago"}, {"id": "vitacura", "name": "Vitacura", "parentName": "Región Metropolitana de Santiago"}, {"id": "puente-alto", "name": "Puente Alto", "parentName": "Región Metropolitana de Santiago"}, {"id": "pirque", "name": "Pirque", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-jose-de-maipo", "name": "San José de Maipo", "parentName": "Región Metropolitana de Santiago"}, {"id": "colina", "name": "Colina", "parentName": "Región Metropolitana de Santiago"}, {"id": "lampa", "name": "Lampa", "parentName": "Región Metropolitana de Santiago"}, {"id": "tiltil", "name": "Tiltil", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-bernardo", "name": "San Bernardo", "parentName": "Región Metropolitana de Santiago"}, {"id": "buin", "name": "Buin", "parentName": "Región Metropolitana de Santiago"}, {"id": "calera-de-tango", "name": "Calera de Tango", "parentName": "Región Metropolitana de Santiago"}, {"id": "paine", "name": "Paine", "parentName": "Región Metropolitana de Santiago"}, {"id": "melipilla", "name": "Melipilla", "parentName": "Región Metropolitana de Santiago"}, {"id": "alhue", "name": "Alhué", "parentName": "Región Metropolitana de Santiago"}, {"id": "curacavi", "name": "Curacaví", "parentName": "Región Metropolitana de Santiago"}, {"id": "maria-pinto", "name": "María Pinto", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-pedro", "name": "San Pedro", "parentName": "Región Metropolitana de Santiago"}, {"id": "talagante", "name": "Talagante", "parentName": "Región Metropolitana de Santiago"}, {"id": "el-monte", "name": "El Monte", "parentName": "Región Metropolitana de Santiago"}, {"id": "isla-de-maipo", "name": "Isla de Maipo", "parentName": "Región Metropolitana de Santiago"}, {"id": "padre-hurtado", "name": "Padre Hurtado", "parentName": "Región Metropolitana de Santiago"}, {"id": "penaflor", "name": "Peñaflor", "parentName": "Región Metropolitana de Santiago"}
];

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

export function App() {
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
    <div className="demo-shell">
      <header className="demo-header">
        <h1>Elementos · AddressInput</h1>
        <p>
          Playground del elemento de captura de direcciones. La configuración de la izquierda
          reinicia el componente; el panel derecho muestra lo que produce.
        </p>
      </header>

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
    </div>
  );
}
