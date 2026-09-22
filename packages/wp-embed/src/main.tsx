import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { httpClient, type GeoBias, type LocationValue } from "@bbacigalupo/geo-core";
import { AddressBatch } from "@bbacigalupo/address-batch";
import { AddressInput, type CaptureModes } from "@bbacigalupo/address-input";
import type { TileThemeName } from "@bbacigalupo/address-input";
import "@bbacigalupo/address-batch/styles.css";
import "@bbacigalupo/address-input/styles.css";

/**
 * Punto de entrada del bundle standalone. Se compila a un único IIFE
 * (`vite.config.ts`) que cualquier página web carga con un `<script>`
 * normal, sin bundler propio del lado del sitio — nada de esto corre por
 * import de otro paquete, es la puerta de entrada del `<script>` en sí.
 * Nada de lo que hay acá es específico de WordPress (el plugin de
 * WordPress es solo UN consumidor de este mismo bundle, ver
 * `wp-plugin/allride-geocodificador/`); cualquier web —de cualquier
 * tecnología— lo usa igual.
 *
 * Quien lo integra solo emite un contenedor con la config en `data-config`:
 *
 *   <div class="allride-address-batch"
 *        data-config='{"apiBaseUrl":"https://geo.allrideapp.com/api/geo"}'></div>
 *
 *   <div class="allride-address-input"
 *        data-config='{"apiBaseUrl":"...", "bias":{"country":"CL"}}'></div>
 *
 * y este script escanea el DOM y monta ahí — así una página puede traer
 * varias instancias (de uno u otro elemento, o ambos) sin JS aparte por
 * instancia.
 */

interface BatchEmbedConfig {
  /** Base del backend que expone `createGeoHandlers` de geo-core (ver `packages/wp-geocoder-api`). Obligatorio. */
  apiBaseUrl?: string;
  bias?: Omit<GeoBias, "country">;
  /**
   * El país NO viaja fijo en esta config a propósito: `countryPicker` lo
   * pide en la UI (sin default) porque este elemento puede llegar a gente
   * de cualquier país. `countryCodes`, si viene, acota la lista ofrecida;
   * sin valor se ofrecen todos.
   */
  countryCodes?: string[];
  maxRows?: number;
  concurrency?: number;
  minIntervalMs?: number;
}

interface InputEmbedConfig {
  /** Base del backend que expone `createGeoHandlers` de geo-core. Obligatorio. */
  apiBaseUrl?: string;
  /**
   * A diferencia del embed de carga masiva, acá `bias.country` es
   * obligatorio: la captura individual no trae selector de país propio
   * (ese diseño es específico del elemento de carga masiva). Quien integra
   * este elemento ya sabe en qué país opera su propia app.
   */
  bias?: GeoBias;
  modes?: Partial<CaptureModes>;
  label?: string;
  helpText?: string;
  map?: { theme?: TileThemeName };
  /**
   * Si viene, se crea un `<input type="hidden">` con este `name` dentro del
   * contenedor, con el `LocationValue` capturado como JSON — para que un
   * `<form>` nativo que envuelva al contenedor lo mande sin JS propio.
   */
  formFieldName?: string;
}

const DEFAULTS = {
  maxRows: 100,
  concurrency: 2,
  // LocationIQ free tier: 2 consultas/seg comprometidas — más rápido arriesga 429 en ráfaga.
  minIntervalMs: 550,
};

function renderError(el: HTMLElement, message: string): void {
  el.textContent = message;
  el.style.cssText = "color:#991b1b;font:14px/1.5 system-ui,sans-serif;padding:12px;";
}

function mountBatch(el: HTMLElement, config: BatchEmbedConfig): void {
  if (!config.apiBaseUrl) {
    renderError(el, "Falta configurar la URL del backend de geocodificación (apiBaseUrl).");
    return;
  }
  el.classList.add("arb-root");
  const root = createRoot(el);
  root.render(
    createElement(AddressBatch, {
      client: httpClient(config.apiBaseUrl),
      // `country` va vacío a propósito: `countryPicker` lo pisa con lo que
      // elija la persona, nunca se usa este valor para geocodificar.
      bias: { ...config.bias, country: "" },
      countryPicker: { codes: config.countryCodes },
      maxRows: config.maxRows ?? DEFAULTS.maxRows,
      concurrency: config.concurrency ?? DEFAULTS.concurrency,
      minIntervalMs: config.minIntervalMs ?? DEFAULTS.minIntervalMs,
      // Herramienta pública compartida: el avance de una persona no debe
      // quedar guardado en el navegador para la siguiente que lo abra.
      storageKey: undefined,
      // Solo el resumen (conteos), no las filas: son datos reales de
      // personas y este evento queda visible en el DOM de la página que
      // integra el elemento. Quien necesite las filas mismas usa los
      // botones de exportación ya incluidos en la UI, o `@bbacigalupo/geo-batch-api`
      // si necesita el resultado por API en vez de en pantalla.
      onComplete: (result) => {
        el.dispatchEvent(new CustomEvent("allride:batch-complete", { detail: result.summary, bubbles: true }));
      },
    }),
  );
}

/**
 * A diferencia de `mountBatch`, acá el contenedor no puede quedar 100% en
 * manos de React: si `formFieldName` viene configurado, necesita un
 * `<input type="hidden">` como hermano del árbol de React (no un hijo suyo,
 * porque `createRoot` reemplaza todo lo que haya dentro del nodo que se le
 * pasa) para que un `<form>` que envuelva al contenedor lo mande solo.
 */
function mountInput(el: HTMLElement, config: InputEmbedConfig): void {
  if (!config.apiBaseUrl) {
    renderError(el, "Falta configurar la URL del backend de geocodificación (apiBaseUrl).");
    return;
  }
  if (!config.bias?.country) {
    renderError(el, "Falta configurar el país (bias.country) para la captura de direcciones.");
    return;
  }

  const mountPoint = document.createElement("div");
  el.appendChild(mountPoint);

  let hiddenInput: HTMLInputElement | null = null;
  if (config.formFieldName) {
    hiddenInput = document.createElement("input");
    hiddenInput.type = "hidden";
    hiddenInput.name = config.formFieldName;
    el.appendChild(hiddenInput);
  }

  const root = createRoot(mountPoint);
  root.render(
    createElement(AddressInput, {
      client: httpClient(config.apiBaseUrl),
      bias: config.bias,
      modes: config.modes,
      label: config.label,
      helpText: config.helpText,
      map: config.map,
      onChange: (value: LocationValue | null) => {
        if (hiddenInput) hiddenInput.value = value ? JSON.stringify(value) : "";
        el.dispatchEvent(new CustomEvent("allride:address-change", { detail: value, bubbles: true }));
      },
    }),
  );
}

function parseConfig<T>(el: HTMLElement): T {
  const raw = el.dataset.config;
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function mountAll(): void {
  document
    .querySelectorAll<HTMLElement>(".allride-address-batch:not([data-allride-mounted])")
    .forEach((el) => {
      el.dataset.allrideMounted = "true";
      mountBatch(el, parseConfig<BatchEmbedConfig>(el));
    });

  document
    .querySelectorAll<HTMLElement>(".allride-address-input:not([data-allride-mounted])")
    .forEach((el) => {
      el.dataset.allrideMounted = "true";
      mountInput(el, parseConfig<InputEmbedConfig>(el));
    });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAll);
} else {
  mountAll();
}

// Para montar a mano (otro CMS, un timing distinto) sin depender del escaneo automático.
(
  window as unknown as {
    AllrideAddressBatch: { mount: typeof mountBatch };
    AllrideAddressInput: { mount: typeof mountInput };
  }
).AllrideAddressBatch = { mount: mountBatch };
(
  window as unknown as {
    AllrideAddressBatch: { mount: typeof mountBatch };
    AllrideAddressInput: { mount: typeof mountInput };
  }
).AllrideAddressInput = { mount: mountInput };
