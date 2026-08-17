/**
 * Lista de países para el selector obligatorio (ver `countryPicker` en
 * `AddressBatch`). Solo los códigos ISO-3166-1 alpha-2 — el nombre en
 * español se genera en el navegador con `Intl.DisplayNames`, sin traducir
 * nada a mano ni sumar una dependencia solo para esto.
 */

// prettier-ignore
const ISO_COUNTRY_CODES = [
  // América
  "AR", "BO", "BR", "CL", "CO", "CR", "CU", "DO", "EC", "SV", "GT", "GY",
  "HT", "HN", "MX", "NI", "PA", "PY", "PE", "PR", "SR", "UY", "VE",
  "CA", "US",
  // Europa
  "AL", "AD", "AT", "BY", "BE", "BA", "BG", "HR", "CY", "CZ", "DK", "EE",
  "FI", "FR", "DE", "GR", "HU", "IS", "IE", "IT", "XK", "LV", "LI", "LT",
  "LU", "MT", "MD", "MC", "ME", "NL", "MK", "NO", "PL", "PT", "RO", "RU",
  "SM", "RS", "SK", "SI", "ES", "SE", "CH", "UA", "GB", "VA",
  // Asia
  "AF", "AM", "AZ", "BH", "BD", "BT", "BN", "KH", "CN", "GE", "IN", "ID",
  "IR", "IQ", "IL", "JP", "JO", "KZ", "KW", "KG", "LA", "LB", "MY", "MV",
  "MN", "MM", "NP", "KP", "OM", "PK", "PS", "PH", "QA", "SA", "SG", "KR",
  "LK", "SY", "TW", "TJ", "TH", "TL", "TR", "TM", "AE", "UZ", "VN", "YE",
  // África
  "DZ", "AO", "BJ", "BW", "BF", "BI", "CM", "CV", "CF", "TD", "KM", "CG",
  "CD", "CI", "DJ", "EG", "GQ", "ER", "SZ", "ET", "GA", "GM", "GH", "GN",
  "GW", "KE", "LS", "LR", "LY", "MG", "MW", "ML", "MR", "MU", "MA", "MZ",
  "NA", "NE", "NG", "RW", "ST", "SN", "SC", "SL", "SO", "ZA", "SS", "SD",
  "TZ", "TG", "TN", "UG", "ZM", "ZW",
  // Oceanía
  "AU", "FJ", "NZ", "PG", "WS", "SB", "TO", "VU",
] as const;

export interface CountryOption {
  code: string;
  label: string;
}

let displayNames: Intl.DisplayNames | null | undefined;

function regionName(code: string): string {
  if (displayNames === undefined) {
    try {
      displayNames = new Intl.DisplayNames(["es"], { type: "region" });
    } catch {
      // Navegador sin Intl.DisplayNames (poco probable, pero no debe romper
      // el selector): se muestra el código tal cual en vez de nada.
      displayNames = null;
    }
  }
  return displayNames?.of(code) ?? code;
}

/**
 * Países ofrecidos en el selector, con su nombre en español, ordenados
 * alfabéticamente. `codes` acota la lista (ej. solo los que de verdad
 * importan para un despliegue puntual); sin valor, se ofrecen todos.
 */
export function countryOptions(codes?: readonly string[]): CountryOption[] {
  const list = codes ?? ISO_COUNTRY_CODES;
  return list
    .map((code) => ({ code: code.toUpperCase(), label: regionName(code.toUpperCase()) }))
    .sort((a, b) => a.label.localeCompare(b.label, "es"));
}
