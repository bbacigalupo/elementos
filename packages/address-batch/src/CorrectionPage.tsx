import type { GeoBias, GeoClient, TileConfig, TileThemeName } from "@allride/geo-core";
import { CorrectionForm } from "./CorrectionForm.tsx";
import { useCorrectionLink, type CorrectionLinkError } from "./useCorrectionLink.ts";
import { DEFAULT_BATCH_TEXTS, type BatchTexts } from "./texts.ts";

/**
 * Página montable de corrección — lo que abre una persona SIN clave de API
 * al hacer clic en un link firmado (`createCorrectionLink` en
 * `@allride/geo-batch-api`). Un componente, no un elemento con fases como
 * `<AddressBatch>`: acá solo hay una fila y una tarea.
 *
 * Quien despliega la monta en su propia ruta (`/corregir`, la página que
 * `correctionLinks.baseUrl` apunta al emitir el link) y le pasa el `token`
 * que trae la URL como query param.
 */

export interface CorrectionPageProps {
  token: string;
  /** Base del endpoint público de corrección, SIN el token — ej. "https://api.miapp.cl/v1/corrections". */
  apiBaseUrl: string;
  /**
   * Para buscar direcciones mientras se escribe. El mismo proxy geo-core
   * público que usa el resto de los elementos — buscar no necesita el
   * token, que solo autoriza leer y corregir ESTA fila.
   */
  client: GeoClient;
  bias: GeoBias;
  texts?: Partial<BatchTexts>;
  map?: { theme?: TileThemeName; tiles?: TileConfig };
  className?: string;
}

function errorText(error: CorrectionLinkError | null, texts: BatchTexts): string {
  switch (error?.code) {
    case "expired_token":
      return texts.correctionLinkExpired;
    case "malformed_token":
    case "invalid_token":
      return texts.correctionLinkInvalid;
    case "not_found":
      return texts.correctionLinkNotFound;
    case "network_error":
      return texts.correctionLinkNetworkError;
    default:
      return texts.correctionLinkGenericError;
  }
}

export function CorrectionPage({
  token,
  apiBaseUrl,
  client,
  bias,
  texts: textsOverride,
  map,
  className,
}: CorrectionPageProps) {
  const texts: BatchTexts = { ...DEFAULT_BATCH_TEXTS, ...textsOverride };
  const link = useCorrectionLink({ token, apiBaseUrl });
  const root = `arb-root arb-correction-page ${className ?? ""}`;

  if (link.phase === "loading") {
    return (
      <div className={root}>
        <p className="arb-help" role="status">
          {texts.correctionLoading}
        </p>
      </div>
    );
  }

  // Sin fila que mostrar (falló la carga inicial): la página entera es el
  // error, no hay formulario detrás que dejar a medio armar.
  if (!link.result) {
    return (
      <div className={root}>
        <p className="arb-notice arb-notice-error" role="alert">
          {errorText(link.error, texts)}
        </p>
        {link.error?.code === "network_error" && (
          <button type="button" className="arb-button" onClick={link.retry}>
            {texts.correctionLinkRetry}
          </button>
        )}
      </div>
    );
  }

  if (link.phase === "done") {
    return (
      <div className={root}>
        <p className="arb-notice" role="status">
          {texts.correctionLinkDone}
        </p>
      </div>
    );
  }

  return (
    <div className={root}>
      {/* Un error al ENVIAR (a diferencia de al cargar) no reemplaza el
          formulario: el punto que la persona ya eligió sigue a la vista,
          para reintentar sin buscar la dirección de nuevo. */}
      {link.error && (
        <p className="arb-notice arb-notice-error" role="alert">
          {errorText(link.error, texts)}
        </p>
      )}
      <CorrectionForm
        result={link.result}
        client={client}
        bias={bias}
        texts={texts}
        map={map}
        onResolve={(value) => void link.submit(value)}
      />
    </div>
  );
}

export default CorrectionPage;
