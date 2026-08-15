import { useId, useRef, useState, type ReactNode } from "react";
import { AdminAreaSelect } from "./AdminAreaSelect.tsx";
import { ConfirmMap } from "./ConfirmMap.tsx";
import { Highlight } from "./Highlight.tsx";
import {
  IconCoordinates,
  IconCrosshair,
  IconMapPin,
  IconSearch,
  IconX,
} from "./icons.tsx";
import type { MarkerConfig, TileConfig, TileThemeName } from "./map-config.ts";
import { DEFAULT_TEXTS, type Texts } from "./texts.ts";
import { useAddressCapture, type AddressCaptureConfig } from "./useAddressCapture.ts";

/**
 * <AddressInput> — UI completa de captura de dirección sobre el hook
 * headless `useAddressCapture`. Si necesitas otra apariencia, usa el hook
 * directamente y arma tu propia UI; este componente es la referencia.
 *
 * Estilos en styles.css (prefijo .ari-), personalizables con variables CSS.
 */

export interface AddressInputProps extends AddressCaptureConfig {
  label?: string;
  helpText?: string;
  /** Aviso de privacidad para captura de domicilios particulares. */
  privacyHint?: boolean;
  texts?: Partial<Texts>;
  /** Apariencia del mapa de confirmación: estilo de tiles y marcador. */
  map?: {
    theme?: TileThemeName;
    tiles?: TileConfig;
    marker?: MarkerConfig;
  };
  className?: string;
}

export function AddressInput({
  label,
  helpText,
  privacyHint,
  texts: textsOverride,
  map: mapConfig,
  className,
  ...config
}: AddressInputProps) {
  const capture = useAddressCapture(config);
  const texts: Texts = { ...DEFAULT_TEXTS, ...textsOverride };
  const listboxId = useId();

  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [coordsOpen, setCoordsOpen] = useState(false);
  const [coordsText, setCoordsText] = useState("");
  const [coordsError, setCoordsError] = useState<string | null>(null);
  const [coordsWarnings, setCoordsWarnings] = useState<string[]>([]);
  const [mapStatus, setMapStatus] = useState<"loading" | "ready" | "failed">("loading");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const {
    phase,
    modes,
    query,
    setQuery,
    suggestions,
    suggesting,
    suggestionsProvisional,
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
  } = capture;

  const ERROR_TEXTS: Record<NonNullable<typeof errorCode>, string> = {
    not_found: texts.notFound,
    network: texts.networkError,
    gps_denied: texts.gpsDenied,
    gps_unavailable: texts.gpsUnavailable,
    gps_blocked: texts.gpsBlocked,
    gps_no_position: texts.gpsNoPosition,
    gps_timeout: texts.gpsTimeout,
  };
  const errorText = errorCode ? ERROR_TEXTS[errorCode] : null;

  function handleCoordsSubmit() {
    const result = submitCoords(coordsText);
    if (!result.ok) {
      setCoordsError(result.error === "out_of_range" ? texts.coordsOutOfRange : texts.coordsInvalid);
      return;
    }
    setCoordsError(null);
    setCoordsWarnings(result.warnings);
    setCoordsOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const count = navigableCount;
    if (!showDropdown || count === 0) {
      if (e.key === "Enter" && canForceSearch) {
        e.preventDefault();
        runForceSearch();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % count);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? count - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // El índice recorre primero las sugerencias y luego las acciones del
      // pie, así el teclado llega a "Buscar de todas formas" y al mapa.
      if (activeIndex < 0) {
        runForceSearch();
      } else if (activeIndex < suggestions.length) {
        handleSelect(suggestions[activeIndex]);
      } else {
        dropdownActions[activeIndex - suggestions.length]?.run();
      }
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
      setActiveIndex(-1);
    }
  }

  function handleSelect(s: (typeof suggestions)[number]) {
    setDropdownOpen(false);
    setActiveIndex(-1);
    setMapStatus("loading");
    setCoordsWarnings([]);
    selectSuggestion(s);
  }

  function startConfirmingUi() {
    setMapStatus("loading");
    setCoordsWarnings([]);
  }

  function runForceSearch() {
    setDropdownOpen(false);
    setActiveIndex(-1);
    startConfirmingUi();
    forceSearch();
  }

  function runPickOnMap() {
    setDropdownOpen(false);
    setActiveIndex(-1);
    startConfirmingUi();
    pickOnMap();
  }

  /**
   * Acciones fijas al pie del desplegable. Sin ellas, cuando el geocoder
   * devuelve sugerencias que no son lo buscado, la lista tapa las otras
   * formas de capturar la dirección y el flujo queda sin salida visible.
   */
  const dropdownActions: Array<{ key: string; icon: ReactNode; label: string; run: () => void }> = [];
  if (canForceSearch) {
    dropdownActions.push({
      key: "force",
      icon: <IconSearch size={16} />,
      label: texts.forceSearchButton,
      run: runForceSearch,
    });
  }
  if (modes.map) {
    dropdownActions.push({
      key: "map",
      icon: <IconMapPin size={16} />,
      label: texts.pickOnMap,
      run: runPickOnMap,
    });
  }

  // El desplegable también aparece sin sugerencias (mientras busca o si no
  // hubo resultados): ahí sus acciones son la única salida.
  const showDropdown =
    dropdownOpen && phase === "idle" && (suggestions.length > 0 || dropdownActions.length > 0);
  const navigableCount = suggestions.length + dropdownActions.length;
  const showNoResults =
    phase === "idle" && suggested && !suggesting && suggestions.length === 0 && canForceSearch;
  // "weak" con sugerencias en pantalla es el caso reportado: hay opciones,
  // pero ninguna calza con lo escrito.
  const showNoneMatches = matchQuality === "weak" && suggestions.length > 0 && !suggesting;

  return (
    <div className={`ari-root${className ? ` ${className}` : ""}`}>
      {label && <p className="ari-label">{label}</p>}
      {helpText && <p className="ari-help">{helpText}</p>}

      {(phase === "idle" || phase === "resolving") && (
        <div className="ari-stack">
          {privacyHint && <p className="ari-privacy">{texts.privacyHint}</p>}

          {adminAreaOptions.length > 0 && (
            <AdminAreaSelect
              label={adminAreaLabel}
              placeholder={texts.adminAreaPlaceholder}
              clearLabel={texts.clearInput}
              options={adminAreaOptions}
              value={adminArea}
              onChange={setAdminArea}
              disabled={phase === "resolving"}
            />
          )}

          {adminAreaRequired && !adminArea && (
            <p className="ari-hint">{texts.adminAreaRequiredHint}</p>
          )}

          {modes.search && (
            <div className="ari-field">
              <input
                ref={inputRef}
                type="text"
                className={`ari-input${query.length > 0 ? " ari-input-clearable" : ""}`}
                role="combobox"
                aria-expanded={showDropdown}
                aria-controls={listboxId}
                aria-autocomplete="list"
                autoComplete="off"
                placeholder={texts.searchPlaceholder}
                value={query}
                disabled={phase === "resolving" || (adminAreaRequired && !adminArea)}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setDropdownOpen(true);
                  setActiveIndex(-1);
                }}
                onFocus={() => setDropdownOpen(true)}
                onBlur={() => {
                  // Con retraso: un tap en una sugerencia dispara blur antes
                  // que el click; pointerdown en la opción gana igual, esto
                  // es solo para cerrar al tocar fuera.
                  window.setTimeout(() => setDropdownOpen(false), 150);
                }}
                onKeyDown={handleKeyDown}
              />
              {suggesting && <span className="ari-progress" aria-hidden="true" />}
              {query.length > 0 && phase !== "resolving" && (
                <button
                  type="button"
                  className="ari-clear"
                  aria-label={texts.clearInput}
                  title={texts.clearInput}
                  // pointerdown para que el tap no se pierda con el blur del
                  // input, igual que en las opciones del desplegable.
                  onPointerDown={(e) => {
                    e.preventDefault();
                    clearQuery();
                    setActiveIndex(-1);
                    inputRef.current?.focus();
                  }}
                >
                  <IconX size={16} />
                </button>
              )}
              {showDropdown && (
                <div className="ari-dropdown">
                  {suggestions.length === 0 && suggesting && (
                    // Esqueleto: ocupa el lugar donde van a aparecer las
                    // opciones. Da algo que mirar mientras se espera, que se
                    // percibe más corto que una línea de texto inmóvil.
                    <ul className="ari-suggestions" aria-hidden="true">
                      {[0, 1, 2].map((i) => (
                        <li key={i} className="ari-skeleton-row">
                          <span className="ari-skeleton ari-skeleton-label" />
                          <span className="ari-skeleton ari-skeleton-sub" />
                        </li>
                      ))}
                    </ul>
                  )}
                  {suggestions.length > 0 && (
                    <ul
                      id={listboxId}
                      role="listbox"
                      className={`ari-suggestions${suggestionsProvisional ? " ari-suggestions-provisional" : ""}`}
                    >
                      {suggestions.map((s, i) => (
                        <li key={s.id} role="option" aria-selected={i === activeIndex}>
                          <button
                            type="button"
                            className={`ari-suggestion${i === activeIndex ? " ari-suggestion-active" : ""}`}
                            // pointerdown y no click: debe ganarle al blur del input
                            onPointerDown={(e) => {
                              e.preventDefault();
                              handleSelect(s);
                            }}
                          >
                            {/* Resaltar lo que coincide hace evidente lo que
                                no: "Las Perdices" vs "Las Raíces". */}
                            <span className="ari-suggestion-label">
                              <Highlight text={s.label} query={query} />
                            </span>
                            {s.sublabel && (
                              <span className="ari-suggestion-sub">
                                <Highlight text={s.sublabel} query={query} />
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Pie fijo: queda siempre visible aunque la lista tenga
                      scroll, así las alternativas nunca quedan tapadas. */}
                  {dropdownActions.length > 0 && (
                    <div className="ari-dropdown-actions">
                      <p className="ari-dropdown-hint">
                        {suggesting
                          ? texts.searching
                          : showNoneMatches
                            ? texts.noneMatches
                            : suggestions.length === 0
                              ? texts.noSuggestions
                              : texts.forceSearchHint}
                      </p>
                      {dropdownActions.map((action, i) => {
                        const index = suggestions.length + i;
                        return (
                          <button
                            key={action.key}
                            type="button"
                            className={`ari-dropdown-action${index === activeIndex ? " ari-suggestion-active" : ""}`}
                            onPointerDown={(e) => {
                              e.preventDefault();
                              action.run();
                            }}
                          >
                            <span className="ari-action-icon">{action.icon}</span>
                          {action.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Con el desplegable abierto estas mismas salidas viven en su pie
              fijo; duplicarlas acá solo agregaría ruido. */}
          {modes.search && !showDropdown && suggesting && <p className="ari-hint">{texts.searching}</p>}
          {modes.search && !showDropdown && showNoResults && (
            <p className="ari-hint">{texts.noSuggestions}</p>
          )}

          {modes.search && !showDropdown && canForceSearch && (
            <div className="ari-force">
              <span className="ari-hint">{showNoneMatches ? texts.noneMatches : texts.forceSearchHint}</span>
              <button
                type="button"
                className="ari-linkbtn"
                disabled={phase === "resolving"}
                onClick={runForceSearch}
              >
                <span className="ari-action-icon">
                  <IconSearch size={16} />
                </span>
                {phase === "resolving" ? texts.resolving : texts.forceSearchButton}
              </button>
            </div>
          )}

          {errorText && <p className="ari-error">{errorText}</p>}

          <div className="ari-actions">
            {modes.gps && gpsAvailable && (
              <button
                type="button"
                className="ari-linkbtn"
                disabled={phase === "resolving"}
                onClick={() => {
                  startConfirmingUi();
                  useGps();
                }}
              >
                <span className="ari-action-icon">
                  <IconCrosshair size={16} />
                </span>
                {texts.useGps}
              </button>
            )}
            {modes.map && (
              <button
                type="button"
                className="ari-linkbtn"
                disabled={phase === "resolving"}
                onClick={runPickOnMap}
              >
                <span className="ari-action-icon">
                  <IconMapPin size={16} />
                </span>
                {texts.pickOnMap}
              </button>
            )}
            {modes.coords && (
              <button
                type="button"
                className="ari-linkbtn"
                disabled={phase === "resolving"}
                onClick={() => setCoordsOpen((v) => !v)}
              >
                <span className="ari-action-icon">
                  <IconCoordinates size={16} />
                </span>
                {texts.enterCoords}
              </button>
            )}
          </div>

          {modes.coords && coordsOpen && (
            <div className="ari-coords">
              <input
                type="text"
                className="ari-input"
                inputMode="text"
                placeholder={texts.coordsPlaceholder}
                value={coordsText}
                onChange={(e) => {
                  setCoordsText(e.target.value);
                  setCoordsError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    startConfirmingUi();
                    handleCoordsSubmit();
                  }
                }}
              />
              <p className="ari-hint">{texts.coordsHelp}</p>
              {coordsError && <p className="ari-error">{coordsError}</p>}
              <button
                type="button"
                className="ari-btn ari-btn-secondary"
                onClick={() => {
                  startConfirmingUi();
                  handleCoordsSubmit();
                }}
              >
                {texts.coordsSubmit}
              </button>
            </div>
          )}
        </div>
      )}

      {phase === "confirming" && candidate && (
        <div className="ari-stack">
          {matchedLevel === "zone" && <p className="ari-warn">{texts.matchedZone}</p>}
          {matchedLevel === "street" && <p className="ari-warn">{texts.matchedStreet}</p>}
          {adminAreaMismatch && <p className="ari-warn">{texts.adminAreaMismatch}</p>}
          {belowMinPrecision && matchedLevel !== "zone" && (
            <p className="ari-warn">{texts.belowMinPrecision}</p>
          )}
          {coordsWarnings.includes("swapped") && <p className="ari-warn">{texts.coordsSwapped}</p>}
          {coordsWarnings.includes("far_from_bias") && <p className="ari-warn">{texts.coordsFar}</p>}

          <div className="ari-mapwrap">
            <ConfirmMap
              lat={candidate.lat}
              lng={candidate.lng}
              zoom={candidate.precision === "zone" ? 13 : 17}
              onMove={movePin}
              recenterTo={recenterRequest}
              tileTheme={mapConfig?.theme}
              tiles={mapConfig?.tiles}
              marker={mapConfig?.marker}
              onStatus={(status) => {
                setMapStatus(status);
                if (status === "failed") reportMapFailed();
              }}
            />
            {/* Salida cuando el pin quedó lejos: arrastrar el mapa a ciegas
                hasta la zona correcta es lento, sobre todo en móvil. */}
            {modes.gps && gpsAvailable && mapStatus !== "failed" && (
              <button
                type="button"
                className="ari-map-locate"
                disabled={gpsBusy}
                onClick={recenterOnGps}
                title={texts.centerOnMe}
              >
                <IconCrosshair size={16} />
                <span>{gpsBusy ? texts.centeringOnMe : texts.centerOnMe}</span>
              </button>
            )}
            {mapStatus === "failed" && (
              <div className="ari-map-fallback">
                <p>{texts.mapFailed}</p>
              </div>
            )}
          </div>

          <div className="ari-summary">
            <p className="ari-formatted">
              {candidate.formatted || `${candidate.lat.toFixed(6)}, ${candidate.lng.toFixed(6)}`}
            </p>
            <p className="ari-note">
              {reverseBusy
                ? texts.reverseBusy
                : mapStatus === "failed"
                  ? texts.confirmMapFailed
                  : texts.confirmQuestion}
            </p>
          </div>

          {/* Sin esto, una falla del GPS acá era invisible: el botón volvía a
              su estado normal y no pasaba nada más. */}
          {errorText && <p className="ari-error">{errorText}</p>}

          {farPending && (
            <p className="ari-warn">
              {texts.farWarning}
              {distanceFromBiasKm !== null && ` (${Math.round(distanceFromBiasKm)} km)`}
            </p>
          )}

          <div className="ari-row">
            <button type="button" className="ari-btn ari-btn-secondary" onClick={edit}>
              {texts.back}
            </button>
            <button type="button" className="ari-btn" disabled={reverseBusy} onClick={confirm}>
              {farPending ? texts.confirmAnyway : texts.confirm}
            </button>
          </div>
        </div>
      )}

      {phase === "confirmed" && value && (
        <div className="ari-confirmed">
          <p className="ari-formatted">✅ {value.formatted}</p>
          <button type="button" className="ari-linkbtn" onClick={edit}>
            {texts.edit}
          </button>
        </div>
      )}
    </div>
  );
}
