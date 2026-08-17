import { ProviderAuthError, ProviderRateLimitError } from "./fetch-retry.ts";
import type { GeoProvider } from "./providers/types.ts";

/**
 * Cortacircuitos para el proveedor de geocoding.
 *
 * Sin esto, una caída del proveedor se amplifica: cada petición reintenta
 * hasta tres veces (ver fetch-retry.ts), así que cien personas escribiendo
 * durante una caída generan trescientas llamadas por minuto contra un
 * servicio que ya está mal — quemando cuota y, en tiers gratuitos, arriesgando
 * un bloqueo por abuso.
 *
 * Tras varios fallos seguidos el circuito se abre y las llamadas fallan de
 * inmediato, sin tocar la red. Pasado el tiempo de espera deja pasar una
 * sola petición de prueba: si funciona, se cierra; si no, vuelve a esperar.
 *
 * Que el proveedor falle rápido no rompe la captura: el autocompletado es
 * best-effort y la persona conserva el mapa, el GPS y las coordenadas.
 */

export interface CircuitBreakerOptions {
  /** Fallos consecutivos que abren el circuito. */
  failureThreshold?: number;
  /** Tiempo que permanece abierto antes de probar de nuevo. */
  resetMs?: number;
  /** Se invoca al abrir y al cerrar, para registrar el evento. */
  onStateChange?: (state: "abierto" | "cerrado", provider: string) => void;
}

export class CircuitOpenError extends Error {
  constructor(provider: string) {
    super(`El proveedor ${provider} está temporalmente fuera de servicio`);
    this.name = "CircuitOpenError";
  }
}

export function withCircuitBreaker(
  provider: GeoProvider,
  options: CircuitBreakerOptions = {},
): GeoProvider {
  const { failureThreshold = 5, resetMs = 30_000, onStateChange } = options;

  let consecutiveFailures = 0;
  let openUntil = 0;
  /** Evita que varias peticiones prueben a la vez al reabrir. */
  let probing = false;

  function registrarExito() {
    if (consecutiveFailures >= failureThreshold) onStateChange?.("cerrado", provider.name);
    consecutiveFailures = 0;
    openUntil = 0;
    probing = false;
  }

  function registrarFallo() {
    consecutiveFailures += 1;
    probing = false;
    if (consecutiveFailures >= failureThreshold) {
      openUntil = Date.now() + resetMs;
      onStateChange?.("abierto", provider.name);
    }
  }

  async function guard<T>(run: () => Promise<T>): Promise<T> {
    const ahora = Date.now();
    if (openUntil > ahora) throw new CircuitOpenError(provider.name);
    if (openUntil !== 0) {
      // Ventana vencida: pasa una sola petición de prueba, el resto sigue
      // fallando rápido hasta saber si el proveedor volvió.
      if (probing) throw new CircuitOpenError(provider.name);
      probing = true;
    }

    try {
      const result = await run();
      registrarExito();
      return result;
    } catch (err) {
      // Cancelar no es un fallo del proveedor: pasa cada vez que alguien
      // sigue escribiendo y no debe contar para abrir el circuito.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      /*
       * Un 429 tampoco: es el proveedor respondiendo "más lento", no una
       * caída. Contarlo acá tenía un efecto en cascada real (encontrado con
       * un lote de 451 direcciones contra LocationIQ): al pasar el límite
       * por minuto llegan varios 429 seguidos, el circuito se abría y desde
       * ahí TODO salía como CircuitOpenError — un error genérico que
       * escondía el 429 del motor de lote, cuyo manejo adaptativo de ritmo
       * (throttle compartido, reintentos con espera) nunca alcanzaba a
       * actuar. El lote terminaba detenido por "servicio caído" con el
       * proveedor perfectamente sano. La credencial rechazada tampoco abre
       * el circuito, por la razón inversa: debe llegar intacta al motor
       * para que marque el trabajo como `failed` (revisar la clave), no
       * como una caída transitoria que se reintenta sola.
       */
      if (err instanceof ProviderRateLimitError || err instanceof ProviderAuthError) throw err;
      registrarFallo();
      throw err;
    }
  }

  return {
    ...provider,
    autocomplete: (query, bias, opts) => guard(() => provider.autocomplete(query, bias, opts)),
    geocode: (query, bias, opts) => guard(() => provider.geocode(query, bias, opts)),
    reverse: (lat, lng, opts) => guard(() => provider.reverse(lat, lng, opts)),
  };
}
