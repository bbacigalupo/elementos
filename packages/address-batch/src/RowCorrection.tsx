import { useEffect, useRef } from "react";
import {
  correctionMode,
  type BatchResultRow,
  type GeoBias,
  type GeoClient,
  type LocationValue,
  type TileConfig,
  type TileThemeName,
} from "@allride/geo-core";
import { CorrectionForm } from "./CorrectionForm.tsx";
import { fill, type BatchTexts } from "./texts.ts";

/**
 * Corrección a mano de una fila, en un diálogo modal.
 *
 * Es el elemento de captura individual, tal cual, aplicado a una fila del
 * lote. No se reimplementó nada: buscar, elegir sugerencia, marcar en el
 * mapa o pegar coordenadas ya existe, está probado en terreno y su regla
 * —**el pin confirmado es el ground truth**— es exactamente la que hace
 * falta acá. El contenido en sí vive en `CorrectionForm`; este componente
 * solo pone el diálogo alrededor.
 *
 * Va en un modal y no en un panel sobre la tabla porque corregir es una
 * tarea sobre **una** fila: un recuadro flotando encima de la lista deja a
 * quien lo mira preguntándose a cuál de todas pertenece. El modal además
 * trae gratis lo que esa tarea necesita —foco atrapado, Escape para salir,
 * el resto inerte— usando `<dialog>` nativo, sin dependencias.
 */

export interface RowCorrectionProps {
  result: BatchResultRow;
  client: GeoClient;
  bias: GeoBias;
  texts: BatchTexts;
  map?: { theme?: TileThemeName; tiles?: TileConfig };
  onResolve: (value: LocationValue) => void;
  onCancel: () => void;
}

export function RowCorrection({
  result,
  client,
  bias,
  texts,
  map,
  onResolve,
  onCancel,
}: RowCorrectionProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const modo = correctionMode(result);

  useEffect(() => {
    const dialog = dialogRef.current;
    /*
     * Las dos cosas van en el mismo efecto pero con guardas separadas. Con
     * una sola guarda —"si ya está abierto, no hacer nada"— el bloqueo de
     * scroll se perdía: en modo estricto React monta, desmonta y vuelve a
     * montar, y en ese segundo montaje el diálogo ya estaba abierto, así
     * que la función salía antes de tocar el scroll del fondo.
     */
    if (dialog?.isConnected && !dialog.open) dialog.showModal();

    // `showModal()` deja el fondo inerte pero no bloquea su scroll: sin
    // esto, la rueda del mouse mueve la tabla detrás del diálogo.
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previo;
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`arb-dialog arb-dialog-${modo}`}
      aria-labelledby="arb-dialog-title"
      onClose={onCancel}
      onClick={(event) => {
        // Clic en el fondo (fuera de la caja) = cerrar, como se espera de
        // cualquier modal.
        if (event.target === dialogRef.current) dialogRef.current?.close();
      }}
    >
      <div className="arb-dialog-body">
        {/*
         * Cerrar vive en la esquina, no en un pie. El pie ocupaba una franja
         * completa para una sola acción secundaria, y esa franja era justo
         * la que tapaba los botones que importan: confirmar el punto y
         * volver al buscador.
         */}
        <div className="arb-dialog-head">
          <h3 className="arb-panel-title" id="arb-dialog-title">
            {fill(texts.correctingRow, { index: result.row.index })}
          </h3>
          <button
            type="button"
            className="arb-dialog-close"
            aria-label={texts.cancelCorrection}
            onClick={() => dialogRef.current?.close()}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>

        <CorrectionForm result={result} client={client} bias={bias} texts={texts} map={map} onResolve={onResolve} />
      </div>
    </dialog>
  );
}

export default RowCorrection;
