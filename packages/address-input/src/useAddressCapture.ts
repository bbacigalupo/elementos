import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  adminAreaMatches,
  assessSuggestions,
  formatAddress,
  haversineMeters,
  parseCoordinates,
  precisionMeets,
  type AdminAreaOption,
  type CaptureMetrics,
  type GeoBias,
  type GeoClient,
  type LocationValue,
  type MatchAssessment,
  type MatchedLevel,
  type Precision,
  type Suggestion,
} from "@allride/geo-core";

/**
 * Máquina de estados de captura de dirección, sin UI (headless).
 *
 *   idle ──(sugerencia | búsqueda | mapa | GPS | coords)──▶ confirming ──▶ confirmed
 *
 * Todos los caminos convergen en `confirming`: el ground truth es el pin
 * que la persona confirma, no lo que devuelva el geocoder.
 */

export type CapturePhase = "idle" | "resolving" | "confirming" | "confirmed";

export interface CaptureModes {
  search: boolean;
  map: boolean;
  gps: boolean;
  coords: boolean;
}

export interface AddressCaptureConfig {
  client: GeoClient;
  bias: GeoBias;
  modes?: Partial<CaptureModes>;
  /** ms de espera tras la última tecla antes de pedir sugerencias. */
  debounceMs?: number;
  /**
   * Caracteres mínimos antes de buscar. 5 por defecto: con tres o cuatro
   * letras casi ningún resultado sirve para una dirección, y cada intento
   * gasta cuota igual.
   */
  minQueryLength?: number;
  /**
   * Metros que debe moverse el pin para volver a preguntar la dirección.
   * Por debajo de eso la respuesta sería la misma, así que no se pregunta.
   */
  minReverseMeters?: number;
  /** ms de espera tras el último movimiento del pin antes de preguntar. */
  reverseDebounceMs?: number;
  autocompleteLimit?: number;
  /** Si el punto confirmado queda a más de esto del centro del bias, se pide re-confirmar. */
  maxDistanceKm?: number;
  /**
   * División administrativa declarada (comuna, municipio…). Opcional: solo
   * los despliegues que necesitan el dato limpio la piden; el resto usa
   * autocompletado libre.
   */
  adminAreas?: {
    options: AdminAreaOption[];
    /** Etiqueta del selector, ej. "Comuna". */
    label?: string;
    /** Exigir elegirla antes de poder buscar. */
    required?: boolean;
  };
  /**
   * Precisión mínima deseada. No bloquea: si el punto confirmado queda por
   * debajo se avisa y se marca en las métricas.
   */
  minPrecision?: Precision;
  /**
   * Punto de partida para el mapa cuando no hay nada escrito — por ejemplo
   * el origen ya respondido al capturar el destino. Suele estar mucho más
   * cerca que el centro de la ciudad.
   */
  anchor?: { lat: number; lng: number } | null;
  initialValue?: LocationValue | null;
  onChange?: (value: LocationValue | null) => void;
  onMetrics?: (metrics: CaptureMetrics) => void;
}

/** Orden de recentrado para el mapa; `nonce` distingue pedidos repetidos. */
export interface RecenterRequest {
  lat: number;
  lng: number;
  nonce: number;
}

export type CoordsSubmitResult =
  | { ok: true; warnings: string[] }
  | { ok: false; error: "empty" | "unparseable" | "out_of_range" };

export interface AddressCapture {
  phase: CapturePhase;
  modes: CaptureModes;
  // — búsqueda —
  query: string;
  setQuery: (q: string) => void;
  suggestions: Suggestion[];
  /** true mientras hay una petición de sugerencias en vuelo. */
  suggesting: boolean;
  /** true si ya se pidieron sugerencias para el query actual (permite
   * distinguir "sin resultados" de "aún no busca"). */
  suggested: boolean;
  /**
   * Qué tan bien calzan las sugerencias con lo escrito. "weak" (incluye el
   * caso sin sugerencias) es la señal de que la UI debe ofrecer los caminos
   * alternativos junto a la lista, no debajo de ella.
   */
  matchQuality: MatchAssessment | null;
  canForceSearch: boolean;
  // — división administrativa declarada (opcional) —
  adminAreaOptions: AdminAreaOption[];
  adminArea: AdminAreaOption | null;
  setAdminArea: (a: AdminAreaOption | null) => void;
  adminAreaRequired: boolean;
  adminAreaLabel: string;
  selectSuggestion: (s: Suggestion) => void;
  forceSearch: () => void;
  // — otros caminos —
  pickOnMap: () => void;
  useGps: () => void;
  gpsAvailable: boolean;
  /** Lleva el pin a la ubicación actual sin salir de la confirmación. */
  recenterOnGps: () => void;
  gpsBusy: boolean;
  recenterRequest: RecenterRequest | null;
  clearQuery: () => void;
  submitCoords: (text: string) => CoordsSubmitResult;
  // — confirmación —
  candidate: LocationValue | null;
  matchedLevel: MatchedLevel | null;
  reverseBusy: boolean;
  movePin: (lat: number, lng: number) => void;
  reportMapFailed: () => void;
  /** Aviso pendiente de punto lejano: el siguiente confirm() lo acepta. */
  farPending: boolean;
  distanceFromBiasKm: number | null;
  /** true si el candidato actual no alcanza la precisión mínima pedida. */
  belowMinPrecision: boolean;
  /** true si el punto no cae en la división administrativa declarada. */
  adminAreaMismatch: boolean;
  confirm: () => void;
  edit: () => void;
  /** Código del último error para que la UI elija el texto. */
  errorCode:
    | "not_found"
    | "network"
    | "gps_denied"
    | "gps_unavailable"
    | "gps_blocked"
    | "gps_no_position"
    | "gps_timeout"
    | null;
  value: LocationValue | null;
}

const DEFAULT_MODES: CaptureModes = { search: true, map: true, gps: true, coords: true };


/**
 * La Geolocation API distingue tres fallas y cada una pide una acción
 * distinta de la persona; colapsarlas en "no pudimos" deja a alguien
 * reintentando algo que nunca va a funcionar.
 */
function gpsErrorCode(err: GeolocationPositionError): "gps_blocked" | "gps_no_position" | "gps_timeout" {
  if (err.code === err.PERMISSION_DENIED) return "gps_blocked";
  if (err.code === err.TIMEOUT) return "gps_timeout";
  return "gps_no_position";
}

function emptyComponents(country: string): LocationValue["components"] {
  return {
    street: null,
    number: null,
    sublocality: null,
    commune: null,
    city: null,
    region: null,
    postalCode: null,
    country,
  };
}

export function useAddressCapture(config: AddressCaptureConfig): AddressCapture {
  const {
    client,
    bias,
    debounceMs = 300,
    minQueryLength = 5,
    minReverseMeters = 20,
    reverseDebounceMs = 400,
    autocompleteLimit = 5,
    maxDistanceKm = 150,
  } = config;

  const modes = useMemo(() => ({ ...DEFAULT_MODES, ...config.modes }), [config.modes]);
  const adminAreaOptions = config.adminAreas?.options ?? [];
  const adminAreaRequired = Boolean(config.adminAreas?.required);
  const adminAreaLabel = config.adminAreas?.label ?? "Comuna";

  const [phase, setPhase] = useState<CapturePhase>(config.initialValue ? "confirmed" : "idle");
  const [value, setValue] = useState<LocationValue | null>(config.initialValue ?? null);
  const [query, setQueryState] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState(false);
  const [matchQuality, setMatchQuality] = useState<MatchAssessment | null>(null);
  const [candidate, setCandidate] = useState<LocationValue | null>(config.initialValue ?? null);
  const [matchedLevel, setMatchedLevel] = useState<MatchedLevel | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [farPending, setFarPending] = useState(false);
  const [errorCode, setErrorCode] = useState<AddressCapture["errorCode"]>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [adminArea, setAdminArea] = useState<AdminAreaOption | null>(null);
  const [recenterRequest, setRecenterRequest] = useState<RecenterRequest | null>(null);

  // Métricas
  const startedAtRef = useRef<number | null>(null);
  const usedGpsRef = useRef(false);
  const usedMapOnlyRef = useRef(false);
  const usedCoordsRef = useRef(false);
  const mapFailedRef = useRef(false);
  const initialPinRef = useRef<{ lat: number; lng: number } | null>(null);

  const candidateRef = useRef(candidate);
  candidateRef.current = candidate;

  const markStarted = useCallback(() => {
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
  }, []);


  /**
   * Con comuna declarada, la búsqueda se acota a ella: el centro conocido
   * afina el bias y el nombre entra en el texto que se manda al geocoder.
   */
  const effectiveBias = useMemo<GeoBias>(
    () => (adminArea?.center ? { ...bias, center: adminArea.center, radiusKm: adminArea.radiusKm ?? bias.radiusKm } : bias),
    [bias, adminArea],
  );

  /**
   * La comuna viaja como dato estructurado hasta el proveedor, no pegada al
   * texto: LocationIQ y Nominatim la usan como campo propio y resuelven
   * calle+número mucho mejor así. Concatenarla degradaba los resultados
   * (devolvía la comuna misma como primera sugerencia).
   */
  const areaOption = useMemo(
    () => (adminArea ? { name: adminArea.name, parentName: adminArea.parentName } : undefined),
    [adminArea],
  );

  /**
   * Lo declarado por la persona manda sobre lo que parsee el geocoder: en
   * Chile los datos OSM devuelven "Santiago" como comuna para direcciones
   * que están en Peñalolén, y la comuna es variable de análisis.
   */
  const applyDeclaredArea = useCallback(
    (v: LocationValue): LocationValue => {
      if (!adminArea) return v;
      // Si el punto está en otra división administrativa, la etiqueta debe
      // describir dónde está el pin de verdad: pisarla produciría una
      // dirección inexistente ("Alicante 937, Providencia"). La UI avisa y
      // la persona corrige el pin o la comuna.
      if (!adminAreaMatches(v, adminArea)) return v;
      const components = {
        ...v.components,
        commune: adminArea.name,
        region: adminArea.parentName ?? v.components.region,
      };
      // El texto visible también se reescribe: corregir solo los componentes
      // dejaba a la persona viendo "Santiago" después de haber declarado
      // "Las Condes", con el dato guardado diciendo otra cosa que la pantalla.
      const streetLine = [components.street, components.number].filter(Boolean).join(" ");
      const firstPart = v.formatted.split(",")[0]?.trim() ?? "";
      // Los POI ("Campus X, Diagonal Las Torres 2640, …") conservan su nombre.
      const poiName = firstPart && firstPart !== streetLine ? firstPart : null;
      const rebuilt = formatAddress(components, v.formatted);
      return {
        ...v,
        components,
        formatted: poiName && streetLine ? `${poiName}, ${rebuilt}` : rebuilt,
      };
    },
    [adminArea],
  );

  // ---------- autocompletado con debounce y cancelación ----------
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (phase !== "idle" || !modes.search) return;
    if (adminAreaRequired && !adminArea) {
      setSuggestions([]);
      setSuggested(false);
      setSuggesting(false);
      setMatchQuality(null);
      return;
    }
    const q = query.trim();
    if (q.length < minQueryLength) {
      setSuggestions([]);
      setSuggested(false);
      setSuggesting(false);
      setMatchQuality(null);
      return;
    }
    setSuggesting(true);
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const results = await client.autocomplete(q, effectiveBias, {
          limit: autocompleteLimit,
          adminArea: areaOption,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setSuggestions(results);
        setSuggested(true);
        setSuggesting(false);
        // Se evalúa contra `q` (el texto que produjo estos resultados), no
        // contra el query actual, que ya pudo cambiar.
        setMatchQuality(assessSuggestions(q, results));
      } catch (err) {
        if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
        // El autocomplete es best-effort: si falla, queda el camino de
        // "Buscar de todas formas" — no bloqueamos con errores.
        setSuggestions([]);
        setSuggested(true);
        setSuggesting(false);
        setMatchQuality("weak");
      }
    }, debounceMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, phase, modes.search, minQueryLength, debounceMs, autocompleteLimit, effectiveBias, areaOption, adminAreaRequired, adminArea]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const setQuery = useCallback(
    (q: string) => {
      markStarted();
      setErrorCode(null);
      setQueryState(q);
    },
    [markStarted],
  );

  const clearQuery = useCallback(() => {
    setQueryState("");
    setSuggestions([]);
    setSuggested(false);
    setMatchQuality(null);
    setErrorCode(null);
  }, []);

  // ---------- transición a confirmación ----------
  const toConfirming = useCallback((v: LocationValue, level: MatchedLevel | null) => {
    // La sugerencia ya trae dirección resuelta para este punto: cuenta como
    // "ya preguntado" y evita una consulta si el pin se mueve apenas.
    lastReversedRef.current = v.formatted ? { lat: v.lat, lng: v.lng } : null;
    setCandidate(v);
    setMatchedLevel(level);
    initialPinRef.current = { lat: v.lat, lng: v.lng };
    setFarPending(false);
    setErrorCode(null);
    setPhase("confirming");
  }, []);

  const selectSuggestion = useCallback(
    (s: Suggestion) => {
      markStarted();
      setSuggestions([]);
      const level: MatchedLevel =
        s.value.precision === "rooftop" ? "address" : s.value.precision === "street" ? "street" : "zone";
      toConfirming(applyDeclaredArea({ ...s.value, source: "autocomplete" }), level);
    },
    [markStarted, toConfirming, applyDeclaredArea],
  );

  const forceSearch = useCallback(() => {
    const q = query.trim();
    if (q.length < minQueryLength) return;
    markStarted();
    setPhase("resolving");
    void (async () => {
      try {
        const outcome = await client.geocode(q, effectiveBias, { adminArea: areaOption });
        if (outcome) {
          toConfirming(applyDeclaredArea({ ...outcome.value, source: "search" }), outcome.matchedLevel);
        } else {
          setErrorCode("not_found");
          setPhase("idle");
        }
      } catch {
        setErrorCode("network");
        setPhase("idle");
      }
    })();
  }, [query, minQueryLength, markStarted, client, effectiveBias, areaOption, applyDeclaredArea, toConfirming]);

  // ---------- reverse geocode al mover el pin ----------
  const reverseAbortRef = useRef<AbortController | null>(null);
  /** Último punto para el que ya se resolvió una dirección. */
  const lastReversedRef = useRef<{ lat: number; lng: number } | null>(null);
  const reverseTimerRef = useRef<number | null>(null);
  const runReverse = useCallback(
    (lat: number, lng: number) => {
      reverseAbortRef.current?.abort();
      const controller = new AbortController();
      reverseAbortRef.current = controller;
      setReverseBusy(true);
      void (async () => {
        try {
          const result = await client.reverse(lat, lng, { lang: bias.lang, signal: controller.signal });
          if (controller.signal.aborted) return;
          lastReversedRef.current = { lat, lng };
          const prev = candidateRef.current;
          if (result && prev) {
            setCandidate(applyDeclaredArea({ ...result, lat, lng, source: "pin" }));
          } else if (prev) {
            // Sin dirección para el nuevo punto: mejor mostrar coordenadas
            // que arrastrar la dirección del punto anterior (sería engañosa).
            setCandidate({ ...prev, lat, lng, source: "pin", formatted: "", components: emptyComponents(bias.country) });
          }
          setReverseBusy(false);
        } catch (err) {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
          const prev = candidateRef.current;
          if (prev) {
            setCandidate({ ...prev, lat, lng, source: "pin", formatted: "", components: emptyComponents(bias.country) });
          }
          setReverseBusy(false);
        }
      })();
    },
    [client, bias.lang, bias.country, applyDeclaredArea],
  );

  const movePin = useCallback(
    (lat: number, lng: number) => {
      const prev = candidateRef.current;
      if (prev) setCandidate({ ...prev, lat, lng, source: "pin" });
      setFarPending(false);

      // Ajustes de pocos metros no cambian la dirección: preguntar de nuevo
      // gastaría cuota para recibir exactamente lo mismo.
      const last = lastReversedRef.current;
      if (last && haversineMeters({ lat, lng }, last) < minReverseMeters) return;

      // Quien acomoda el pin suele tocar varias veces seguidas; solo importa
      // dónde quedó. Se marca ocupado de inmediato para que no se pueda
      // confirmar mientras la dirección todavía no corresponde al pin.
      if (reverseTimerRef.current !== null) window.clearTimeout(reverseTimerRef.current);
      setReverseBusy(true);
      reverseTimerRef.current = window.setTimeout(() => {
        reverseTimerRef.current = null;
        runReverse(lat, lng);
      }, reverseDebounceMs);
    },
    [runReverse, minReverseMeters, reverseDebounceMs],
  );

  useEffect(
    () => () => {
      if (reverseTimerRef.current !== null) window.clearTimeout(reverseTimerRef.current);
    },
    [],
  );

  // ---------- otros caminos de entrada ----------
  /**
   * Abre el mapa con el pin lo más cerca posible del destino real. El centro
   * genérico de la zona puede quedar a decenas de kilómetros del punto
   * buscado, así que si la persona alcanzó a escribir algo se usa la mejor
   * coincidencia encontrada —aunque sea solo la calle o la comuna— como
   * ancla inicial.
   */
  const pickOnMap = useCallback(() => {
    markStarted();
    usedMapOnlyRef.current = true;
    // Prioridad: lo que la persona escribió > el punto de referencia que
    // pasó quien integra (ej. el origen ya respondido) > centro de la zona.
    const anchor = suggestions[0]?.value ?? config.anchor ?? adminArea?.center ?? null;
    const center = anchor ?? bias.center ?? { lat: 0, lng: 0 };
    toConfirming(
      {
        lat: center.lat,
        lng: center.lng,
        formatted: "",
        components: emptyComponents(bias.country),
        precision: "zone",
        source: "pin",
        provider: "user",
        capturedAt: new Date().toISOString(),
      },
      null,
    );
    // Con ancla, el reverse nombra dónde quedó el pin; sin ella no hay nada
    // que nombrar todavía.
    if (anchor) runReverse(anchor.lat, anchor.lng);
  }, [markStarted, suggestions, config.anchor, adminArea, bias.center, bias.country, toConfirming, runReverse]);

  /**
   * Se resuelve DESPUÉS de montar, no durante el render.
   *
   * En el servidor no existe `navigator`, así que calcularlo en el render
   * daba false en el HTML del servidor y true en el cliente: el botón de
   * GPS aparecía solo en el cliente y React abortaba la hidratación de todo
   * el árbol ("server rendered HTML didn't match"). Partiendo en false en
   * ambos lados, el primer render coincide y el botón aparece al montar.
   */
  const [gpsAvailable, setGpsAvailable] = useState(false);
  useEffect(() => {
    setGpsAvailable("geolocation" in navigator && window.isSecureContext);
  }, []);

  const useGps = useCallback(() => {
    markStarted();
    if (!gpsAvailable) {
      setErrorCode("gps_unavailable");
      return;
    }
    usedGpsRef.current = true;
    setPhase("resolving");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        toConfirming(
          {
            lat: latitude,
            lng: longitude,
            formatted: "",
            components: emptyComponents(bias.country),
            precision: accuracy <= 50 ? "rooftop" : "zone",
            source: "gps",
            provider: "gps",
            capturedAt: new Date().toISOString(),
          },
          null,
        );
        runReverse(latitude, longitude);
      },
      (err) => {
        setErrorCode(gpsErrorCode(err));
        setPhase("idle");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [markStarted, gpsAvailable, bias.country, toConfirming, runReverse]);

  /**
   * Ya en la pantalla de confirmación: lleva el pin a la ubicación actual
   * para seguir ajustándolo desde ahí. Es la salida cuando el punto inicial
   * quedó lejos y arrastrar el mapa a ciegas sería tedioso.
   */
  const recenterOnGps = useCallback(() => {
    if (!gpsAvailable) {
      setErrorCode("gps_unavailable");
      return;
    }
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsBusy(false);
        usedGpsRef.current = true;
        const { latitude, longitude } = pos.coords;
        setRecenterRequest({ lat: latitude, lng: longitude, nonce: Date.now() });
        movePin(latitude, longitude);
      },
      (err) => {
        setGpsBusy(false);
        setErrorCode(gpsErrorCode(err));
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [gpsAvailable, movePin]);

  const submitCoords = useCallback(
    (text: string): CoordsSubmitResult => {
      markStarted();
      const parsed = parseCoordinates(text, bias);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      usedCoordsRef.current = true;
      toConfirming(
        {
          lat: parsed.lat,
          lng: parsed.lng,
          formatted: `${parsed.lat.toFixed(6)}, ${parsed.lng.toFixed(6)}`,
          components: emptyComponents(bias.country),
          precision: "exact",
          source: "coords",
          provider: "user",
          capturedAt: new Date().toISOString(),
        },
        null,
      );
      runReverse(parsed.lat, parsed.lng);
      return { ok: true, warnings: parsed.warnings };
    },
    [markStarted, bias, toConfirming, runReverse],
  );

  // ---------- confirmación ----------
  const distanceFromBiasKm = useMemo(() => {
    if (!candidate || !bias.center) return null;
    return haversineMeters(candidate, bias.center) / 1000;
  }, [candidate, bias.center]);

  /** El punto confirmado quedaría fuera de la división declarada. */
  const adminAreaMismatch = useMemo(
    () => (candidate && adminArea ? !adminAreaMatches(candidate, adminArea) : false),
    [candidate, adminArea],
  );

  const belowMinPrecision = useMemo(
    () => (candidate && config.minPrecision ? !precisionMeets(candidate.precision, config.minPrecision) : false),
    [candidate, config.minPrecision],
  );

  const confirm = useCallback(() => {
    const current = candidateRef.current;
    if (!current) return;
    if (distanceFromBiasKm !== null && distanceFromBiasKm > maxDistanceKm && !farPending) {
      setFarPending(true);
      return;
    }
    const confirmedAt = Date.now();
    const startedAt = startedAtRef.current ?? confirmedAt;
    const final: LocationValue = {
      ...current,
      formatted: current.formatted || `${current.lat.toFixed(6)}, ${current.lng.toFixed(6)}`,
    };
    setValue(final);
    setPhase("confirmed");
    config.onChange?.(final);
    config.onMetrics?.({
      startedAt,
      confirmedAt,
      secondsToConfirm: Math.round((confirmedAt - startedAt) / 100) / 10,
      pinMovedMeters: initialPinRef.current ? Math.round(haversineMeters(initialPinRef.current, final)) : 0,
      usedGps: usedGpsRef.current,
      usedMapOnly: usedMapOnlyRef.current,
      usedCoords: usedCoordsRef.current,
      matchedLevel,
      finalPrecision: final.precision,
      mapFailed: mapFailedRef.current,
      belowMinPrecision,
      adminAreaDeclared: adminArea !== null,
      adminAreaMismatch,
    });
  }, [distanceFromBiasKm, maxDistanceKm, farPending, matchedLevel, belowMinPrecision, adminAreaMismatch, adminArea, config]);

  const edit = useCallback(() => {
    setValue(null);
    config.onChange?.(null);
    setCandidate(null);
    setMatchedLevel(null);
    setFarPending(false);
    setErrorCode(null);
    setPhase("idle");
  }, [config]);

  const reportMapFailed = useCallback(() => {
    mapFailedRef.current = true;
  }, []);

  const canForceSearch =
    query.trim().length >= minQueryLength && (!adminAreaRequired || adminArea !== null);

  return {
    phase,
    modes,
    query,
    setQuery,
    suggestions,
    suggesting,
    suggested,
    matchQuality,
    canForceSearch,
    adminAreaOptions,
    adminArea,
    setAdminArea,
    adminAreaRequired,
    adminAreaLabel,
    selectSuggestion,
    forceSearch,
    pickOnMap,
    useGps,
    gpsAvailable,
    recenterOnGps,
    gpsBusy,
    recenterRequest,
    clearQuery,
    submitCoords,
    candidate,
    matchedLevel,
    reverseBusy,
    movePin,
    reportMapFailed,
    farPending,
    distanceFromBiasKm,
    belowMinPrecision,
    adminAreaMismatch,
    confirm,
    edit,
    errorCode,
    value,
  };
}
