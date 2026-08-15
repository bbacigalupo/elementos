import { createGeoHandlers, type GeoHandlersOptions } from "./handlers.ts";

/**
 * Adapter de los handlers web-estándar a middleware estilo Node/Connect
 * (Express, Vite dev server, http.createServer). Requiere Node 18+ (usa
 * Request/Response globales). Tipado estructural para no depender de
 * @types/node ni de Express.
 */

interface NodeIncomingMessage {
  url?: string;
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface NodeServerResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

export interface NodeGeoMiddlewareOptions extends GeoHandlersOptions {
  /** Prefijo de ruta a atender, ej. "/api/geo" (default). */
  basePath?: string;
}

export function createNodeGeoMiddleware(options: NodeGeoMiddlewareOptions) {
  const handlers = createGeoHandlers(options);
  const basePath = (options.basePath ?? "/api/geo").replace(/\/$/, "");

  return async (
    req: NodeIncomingMessage,
    res: NodeServerResponse,
    next?: (err?: unknown) => void,
  ): Promise<void> => {
    const host = (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) ?? "localhost";
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!url.pathname.startsWith(basePath)) {
      next?.();
      return;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) headers.set(key, value.join(", "));
    }

    try {
      const response = await handlers.handle(new Request(url, { method: req.method ?? "GET", headers }));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(await response.text());
    } catch (err) {
      if (next) next(err);
      else {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      }
    }
  };
}
