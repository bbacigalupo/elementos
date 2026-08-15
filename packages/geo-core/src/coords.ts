import { haversineMeters, type GeoBias } from "./types.ts";

/**
 * Parser de coordenadas ingresadas a mano. Acepta:
 * - Decimal: "-33.4489, -70.6693" (separador coma, punto y coma o espacio;
 *   también decimales con coma: "-33,4489 -70,6693")
 * - Grados/minutos/segundos: 33°26'56.0"S 70°39'05.4"W (acepta O de Oeste)
 * - URLs de Google Maps pegadas: ".../@-33.44,-70.66,15z" o "?q=-33.44,-70.66"
 *
 * Valida rangos y detecta lat/lng invertidas (error típico al copiar):
 * si el orden invertido cae dentro de la zona esperada y el directo no,
 * corrige con advertencia.
 */

export type ParseCoordsResult =
  | { ok: true; lat: number; lng: number; warnings: string[] }
  | { ok: false; error: "empty" | "unparseable" | "out_of_range" };

const DMS_RE =
  /(\d{1,3})\s*[°º]\s*(\d{1,2})\s*['′’]\s*(?:(\d{1,2}(?:[.,]\d+)?)\s*["″”]\s*)?([NSEWO])/gi;

function dmsToDecimal(deg: string, min: string, sec: string | undefined, hemi: string): number {
  const value =
    parseInt(deg, 10) + parseInt(min, 10) / 60 + (sec ? parseFloat(sec.replace(",", ".")) / 3600 : 0);
  // S = sur, W/O = oeste (O por "Oeste" en español)
  return /[SWO]/i.test(hemi) ? -value : value;
}

export function parseCoordinates(input: string, bias?: GeoBias): ParseCoordsResult {
  const text = input.trim();
  if (!text) return { ok: false, error: "empty" };

  // 1. URL de Google Maps
  const urlMatch =
    text.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/) ??
    text.match(/[?&](?:q|ll|query|destination|center)=(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
  if (urlMatch) {
    return finish(parseFloat(urlMatch[1]), parseFloat(urlMatch[2]), bias);
  }

  // 2. Grados/minutos/segundos
  const dms = [...text.matchAll(DMS_RE)];
  if (dms.length === 2) {
    let lat: number | null = null;
    let lng: number | null = null;
    for (const m of dms) {
      const decimal = dmsToDecimal(m[1], m[2], m[3], m[4]);
      if (/[NS]/i.test(m[4])) lat = decimal;
      else lng = decimal;
    }
    if (lat !== null && lng !== null) return finish(lat, lng, bias);
    return { ok: false, error: "unparseable" };
  }

  // 3. Par decimal. El regex admite decimales con punto o coma; una coma
  // entre dos números completos actúa como separador del par. Fuera de los
  // dos números solo se aceptan separadores — así "Av. Providencia 1234"
  // no se interpreta como coordenadas.
  const numberRe = /-?\d+(?:[.,]\d+)?/g;
  const tokens = text.match(numberRe);
  const leftover = text.replace(numberRe, "").replace(/[\s,;()]/g, "");
  if (tokens && tokens.length === 2 && leftover === "") {
    return finish(
      parseFloat(tokens[0].replace(",", ".")),
      parseFloat(tokens[1].replace(",", ".")),
      bias,
    );
  }

  return { ok: false, error: "unparseable" };
}

function finish(a: number, b: number, bias?: GeoBias): ParseCoordsResult {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, error: "unparseable" };

  const warnings: string[] = [];
  let lat = a;
  let lng = b;

  // Inversión inequívoca: |lat| > 90 solo puede ser una longitud.
  if (Math.abs(lat) > 90 && Math.abs(lng) <= 90 && Math.abs(lat) <= 180) {
    [lat, lng] = [lng, lat];
    warnings.push("swapped");
  }

  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { ok: false, error: "out_of_range" };

  // Inversión ambigua (ambos ≤ 90): decide la zona esperada, con umbrales
  // conservadores para no "corregir" un punto válido.
  if (bias?.center && Math.abs(lng) <= 90) {
    const direct = haversineMeters({ lat, lng }, bias.center);
    const swapped = haversineMeters({ lat: lng, lng: lat }, bias.center);
    if (direct > 300_000 && swapped < 100_000) {
      [lat, lng] = [lng, lat];
      warnings.push("swapped");
    }
  }

  if (bias?.center) {
    const distanceKm = haversineMeters({ lat, lng }, bias.center) / 1000;
    if (distanceKm > Math.max((bias.radiusKm ?? 50) * 3, 300)) warnings.push("far_from_bias");
  }

  return { ok: true, lat, lng, warnings };
}
