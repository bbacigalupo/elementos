export { AddressBatch, type AddressBatchProps } from "./AddressBatch.tsx";
export { BatchResults, type BatchResultsProps } from "./BatchResults.tsx";
export { BatchExport, type BatchExportProps, type ExportFormatOptions } from "./BatchExport.tsx";
export {
  isSpreadsheet,
  readWorkbook,
  buildWorkbookBlob,
  XlsxUnavailableError,
  type BuildWorkbookOptions,
  type ReadWorkbookOptions,
  type WorkbookSheet,
} from "./xlsx-io.ts";
/**
 * `<BatchMap>` NO se reexporta acá a propósito: hacerlo metería Leaflet y su
 * CSS en el chunk principal y anularía la carga diferida que hace
 * `<BatchResults>`. Quien arme su propia UI lo importa de
 * `@allride/address-batch/map`, que es justamente el chunk aparte.
 */
export type { BatchMapProps } from "./BatchMap.tsx";
export {
  useBatchGeocode,
  type BatchGeocode,
  type BatchGeocodeConfig,
  type BatchPhase,
  type BatchStats,
  type LoadedTable,
} from "./useBatchGeocode.ts";
export { DEFAULT_BATCH_TEXTS, fill, humanDuration, type BatchTexts } from "./texts.ts";
export { snapshotResultsForExport, type BatchSnapshot } from "./snapshot.ts";
export { CorrectionForm, queryWithArea, type CorrectionFormProps } from "./CorrectionForm.tsx";
export { RowCorrection, type RowCorrectionProps } from "./RowCorrection.tsx";
export { CorrectionPage, type CorrectionPageProps } from "./CorrectionPage.tsx";
export {
  useCorrectionLink,
  type CorrectionLinkError,
  type CorrectionLinkPhase,
  type UseCorrectionLinkOptions,
  type UseCorrectionLinkResult,
} from "./useCorrectionLink.ts";
