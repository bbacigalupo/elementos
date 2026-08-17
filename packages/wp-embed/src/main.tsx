import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { httpClient, type GeoBias } from "@allride/geo-core";
import { AddressBatch } from "@allride/address-batch";
import "@allride/address-batch/styles.css";

/**
 * Punto de entrada del bundle standalone. Se compila a un único IIFE
 * (`vite.config.ts`) que WordPress carga con un `<script>` normal — nada de
 * esto corre por import de otro paquete, es la puerta de entrada del
 * `<script>` en sí.
 *
 * El shortcode de WordPress (`allride-wp-plugin/`) solo emite un
 * contenedor con la config en `data-config`:
 *
 *   <div class="allride-address-batch"
 *        data-config='{"apiBaseUrl":"https://geo.allrideapp.com/api/geo"}'></div>
 *
 * y este script escanea el DOM y monta ahí — así una página puede traer
 * más de una instancia (o ninguna) sin JS aparte por instancia.
 *
 * El país NO viaja en esta config: es una herramienta pública que puede
 * llegar a gente de cualquier país, así que se le pide a quien la usa en
 * vez de asumir uno (`countryPicker` en `<AddressBatch>`, sin default a
 * propósito — decisión de Bernardo). `countryCodes`, si viene, acota la
 * lista ofrecida; sin valor se ofrecen todos.
 */

interface EmbedConfig {
  /** Base del backend que expone `createGeoHandlers` de geo-core (ver `packages/wp-geocoder-api`). Obligatorio. */
  apiBaseUrl?: string;
  bias?: Omit<GeoBias, "country">;
  countryCodes?: string[];
  maxRows?: number;
  concurrency?: number;
  minIntervalMs?: number;
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

function mount(el: HTMLElement, config: EmbedConfig): void {
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
    }),
  );
}

function parseConfig(el: HTMLElement): EmbedConfig {
  const raw = el.dataset.config;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as EmbedConfig;
  } catch {
    return {};
  }
}

function mountAll(): void {
  const targets = document.querySelectorAll<HTMLElement>(
    ".allride-address-batch:not([data-allride-mounted])",
  );
  targets.forEach((el) => {
    el.dataset.allrideMounted = "true";
    mount(el, parseConfig(el));
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mountAll);
} else {
  mountAll();
}

// Para montar a mano (otro CMS, un timing distinto) sin depender del escaneo automático.
(window as unknown as { AllrideAddressBatch: { mount: typeof mount } }).AllrideAddressBatch = { mount };
