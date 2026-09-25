import { useState } from "react";
import { AddressInput } from "@bbacigalupo/address-input";
import {
  DEFAULT_ISSUE_TEXTS,
  correctionMode,
  isFailure,
  type BatchResultRow,
  type GeoBias,
  type GeoClient,
  type LocationValue,
  type TileConfig,
  type TileThemeName,
} from "@bbacigalupo/geo-core";
import { googleMapsSearchUrl, needsManualLookup, queryWithArea } from "./google-maps.ts";
import { type BatchTexts } from "./texts.ts";
import "@bbacigalupo/address-input/styles.css";

// Se sigue exportando desde acá: ya era parte de la API pública del paquete.
export { queryWithArea };

/**
 * El contenido de corregir una fila: motivos, y el elemento de captura
 * individual ya armado para partir del texto y el punto que trae la fila.
 *
 * Separado de `RowCorrection` (que lo envuelve en un `<dialog>` para la
 * tabla del lote) porque el mismo contenido también hace falta **sin**
 * diálogo — en una página completa a la que alguien llega por un link de
 * corrección, donde no hay nada detrás que atenuar ni de qué "salir".
 */

export interface CorrectionFormProps {
  result: BatchResultRow;
  client: GeoClient;
  bias: GeoBias;
  texts: BatchTexts;
  map?: { theme?: TileThemeName; tiles?: TileConfig };
  onResolve: (value: LocationValue) => void;
}

export function CorrectionForm({ result, client, bias, texts, map, onResolve }: CorrectionFormProps) {
  const modo = correctionMode(result);
  // Cada clic en "Búscala en Google Maps" pide abrir el campo de coordenadas:
  // lo más probable es que la persona vuelva de esa pestaña con el punto copiado.
  const [coordsRequest, setCoordsRequest] = useState(0);

  /*
   * Los motivos de fallo no se repiten acá. Si alguien llegó a esta pantalla
   * fue porque apretó "Buscar" en una fila fallida: decirle otra vez que no
   * se encontró la dirección no le informa nada, y compite con el mensaje
   * que sí está donde tiene que estar, junto al campo de texto. Los motivos
   * de duda sí se muestran: son la instrucción de qué mirar en el mapa.
   */
  const motivos = result.issues.filter((issue) => !isFailure(issue.code));

  return (
    <>
      {/* La dirección original solo cuando no está a la vista en otro
          lado: en modo buscador ya está escrita en el campo de texto, y
          repetirla arriba es ruido. */}
      {modo === "map" && <p className="arb-correction-original">{result.row.raw}</p>}

      {motivos.length > 0 && (
        <ul className="arb-detail-issues">
          {motivos.map((issue, i) => (
            <li key={`${issue.code}-${i}`}>
              {DEFAULT_ISSUE_TEXTS[issue.code]}
              {issue.detail ? ` (${issue.detail})` : ""}
            </li>
          ))}
        </ul>
      )}

      {/* Referencia externa para las filas difíciles: se abre Google Maps
          para ubicar el lugar y el punto se marca acá, en nuestro mapa. */}
      {needsManualLookup(result) && (
        <p className="arb-external-lookup">
          {texts.externalLookupHint}{" "}
          <a
            className="arb-link"
            href={googleMapsSearchUrl(result, bias.country)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setCoordsRequest((n) => n + 1)}
          >
            {texts.openInGoogleMaps}
            <span aria-hidden="true">{"\u00a0↗"}</span>
            <span className="arb-visually-hidden"> {texts.opensInNewTab}</span>
          </a>
        </p>
      )}

      <AddressInput
        client={client}
        bias={bias}
        // El texto original, no el que devolvió el geocoder: corregir es
        // partir de lo que la persona quiso decir.
        initialQuery={queryWithArea(result)}
        /*
         * Cuando ya hay un punto razonable, se abre directo en el mapa: la
         * tarea es confirmarlo o moverlo unos metros, no reescribir la
         * dirección. Solo se arranca en el buscador cuando lo encontrado
         * probablemente es otro lugar, o cuando no hay nada que mostrar.
         */
        initialCandidate={modo === "map" ? result.value : null}
        anchor={result.value ? { lat: result.value.lat, lng: result.value.lng } : null}
        map={map}
        // Mismas filas que ofrecen buscar en Google Maps: quien la ubicó allá
        // pega el punto acá sin volver al buscador.
        coordsOnConfirm={needsManualLookup(result)}
        coordsRequest={coordsRequest}
        /*
         * En modo mapa no se pone ni encabezado ni ayuda: la pantalla de
         * confirmación del propio elemento ya pregunta "¿Es correcto el
         * punto?" y explica que se toca o se arrastra para moverlo.
         * Agregar arriba otra pregunta y otra explicación decía lo mismo
         * dos veces y, de paso, empujaba el botón de confirmar fuera de
         * la vista.
         */
        label={modo === "map" ? undefined : texts.correctionLabel}
        helpText={modo === "map" ? undefined : texts.correctionHelp}
        texts={{
          /*
           * "Volver" a secas queda justo encima de "Cancelar" y las dos se
           * leen como salidas, cuando una es la salida de verdad y la otra
           * es el otro camino para resolver la fila. El nombre dice a
           * dónde lleva.
           */
          back: texts.switchToSearch,
        }}
        /*
         * Confirmar el pin **es** guardar. Antes había un segundo botón
         * ("Guardar en la fila") con su propio texto explicando que
         * primero había que confirmar: dos pasos y una explicación para
         * algo que la persona ya decidió. Confirmar el punto no puede
         * significar otra cosa que aplicarlo a esta fila.
         */
        onChange={(value) => value && onResolve(value)}
      />
    </>
  );
}

export default CorrectionForm;
