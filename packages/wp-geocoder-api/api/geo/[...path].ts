import { handlers } from "../../lib/handlers.js";

export const config = { runtime: "edge" };

export default function handler(request: Request): Promise<Response> {
  return handlers.handle(request);
}
