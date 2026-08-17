import { Suspense, lazy, useState } from "react";

/**
 * Shell del playground. Un elemento por pestaña, compartiendo el mismo
 * proxy de geocoding y las mismas zonas de bias.
 *
 * Cada pestaña se carga bajo demanda. No es por peso —el playground no lo
 * necesita— sino para que refleje lo que hace un despliegue real: con
 * importación estática, abrir la carga masiva traía igual todo el elemento
 * de captura individual y su Leaflet, y volvía imposible comprobar en el
 * navegador que la corrección a mano sí se carga en diferido.
 */
const AddressInputDemo = lazy(() =>
  import("./AddressInputDemo.tsx").then((m) => ({ default: m.AddressInputDemo })),
);
const BatchDemo = lazy(() => import("./BatchDemo.tsx").then((m) => ({ default: m.BatchDemo })));
const CorrectionPageDemo = lazy(() =>
  import("./CorrectionPageDemo.tsx").then((m) => ({ default: m.CorrectionPageDemo })),
);

const TABS = [
  {
    id: "individual",
    label: "Captura individual",
    title: "Elementos · AddressInput",
    description:
      "Playground del elemento de captura de direcciones. La configuración de la izquierda reinicia el componente; el panel derecho muestra lo que produce.",
    render: () => <AddressInputDemo />,
  },
  {
    id: "masivo",
    label: "Carga masiva",
    title: "Elementos · AddressBatch",
    description:
      "Playground del elemento de geocodificación masiva. Escribe una dirección por línea, o pega celdas copiadas de Excel para que aparezca el mapeo de columnas.",
    render: () => <BatchDemo />,
  },
  {
    id: "correccion",
    label: "Corrección por link",
    title: "Elementos · CorrectionPage",
    description:
      "Playground de la página que abre una persona sin clave de API al hacer clic en un link de corrección firmado (geo-batch-api).",
    render: () => <CorrectionPageDemo />,
  },
] as const;

export function App() {
  // Un link de corrección apunta a esta misma página con `?token=…` — sin
  // esto, quien lo abre caería en la pestaña por defecto en vez de en la
  // página que el link promete.
  const [tabId, setTabId] = useState<(typeof TABS)[number]["id"]>(
    new URLSearchParams(window.location.search).has("token") ? "correccion" : "masivo",
  );
  const tab = TABS.find((t) => t.id === tabId)!;

  return (
    <div className="demo-shell">
      <header className="demo-header">
        <nav className="demo-tabs" aria-label="Elementos">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`demo-tab ${t.id === tabId ? "demo-tab-active" : ""}`}
              aria-current={t.id === tabId ? "page" : undefined}
              onClick={() => setTabId(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <h1>{tab.title}</h1>
        <p>{tab.description}</p>
      </header>

      <Suspense fallback={<p className="demo-empty">Cargando el elemento…</p>}>{tab.render()}</Suspense>
    </div>
  );
}
