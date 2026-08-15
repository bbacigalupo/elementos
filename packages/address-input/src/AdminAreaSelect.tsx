import { useId, useMemo, useState } from "react";
import type { AdminAreaOption } from "@allride/geo-core";
import { IconX } from "./icons.tsx";

/**
 * Selector de división administrativa (comuna, municipio…) con filtro por
 * texto. Es un combobox y no un `<select>` nativo porque los catálogos
 * reales tienen cientos de entradas: escribir tres letras es mucho más
 * rápido que recorrer una lista larga, sobre todo en móvil.
 *
 * Solo aparece cuando quien integra declara `adminAreas`; el resto de los
 * despliegues usa autocompletado libre.
 */

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export interface AdminAreaSelectProps {
  label: string;
  placeholder: string;
  clearLabel: string;
  options: AdminAreaOption[];
  value: AdminAreaOption | null;
  onChange: (option: AdminAreaOption | null) => void;
  disabled?: boolean;
  /** Máximo de coincidencias mostradas a la vez. */
  limit?: number;
}

export function AdminAreaSelect({
  label,
  placeholder,
  clearLabel,
  options,
  value,
  onChange,
  disabled,
  limit = 8,
}: AdminAreaSelectProps) {
  const listboxId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const matches = useMemo(() => {
    const q = normalize(query);
    if (!q) return options.slice(0, limit);
    // Prioriza los que empiezan con lo escrito: quien escribe "pe" busca
    // "Peñalolén" antes que "Lampa" (que también contiene "pa").
    const starts: AdminAreaOption[] = [];
    const contains: AdminAreaOption[] = [];
    for (const option of options) {
      const name = normalize(option.name);
      if (name.startsWith(q)) starts.push(option);
      else if (name.includes(q)) contains.push(option);
      if (starts.length >= limit) break;
    }
    return [...starts, ...contains].slice(0, limit);
  }, [options, query, limit]);

  function choose(option: AdminAreaOption) {
    onChange(option);
    setQuery("");
    setOpen(false);
    setActiveIndex(-1);
  }

  if (value) {
    return (
      <div className="ari-field">
        <span className="ari-sublabel">{label}</span>
        <div className="ari-chosen">
          <span>
            {value.name}
            {value.parentName && <span className="ari-chosen-parent">, {value.parentName}</span>}
          </span>
          <button
            type="button"
            className="ari-clear ari-clear-inline"
            aria-label={clearLabel}
            title={clearLabel}
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setOpen(true);
            }}
          >
            <IconX size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ari-field">
      <span className="ari-sublabel">{label}</span>
      <input
        type="text"
        className="ari-input"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listboxId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => (i <= 0 ? matches.length - 1 : i - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(matches[activeIndex >= 0 ? activeIndex : 0]);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {open && matches.length > 0 && (
        <div className="ari-dropdown">
          <ul id={listboxId} role="listbox" className="ari-suggestions">
            {matches.map((option, i) => (
              <li key={option.id} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  className={`ari-suggestion${i === activeIndex ? " ari-suggestion-active" : ""}`}
                  onPointerDown={(e) => {
                    e.preventDefault();
                    choose(option);
                  }}
                >
                  <span className="ari-suggestion-label">{option.name}</span>
                  {option.parentName && (
                    <span className="ari-suggestion-sub">{option.parentName}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
