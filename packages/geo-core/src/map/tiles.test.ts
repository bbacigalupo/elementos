import { describe, expect, it, vi } from "vitest";
import {
  ensureLabelsPane,
  LABELS_PANE,
  LABELS_PANE_Z_INDEX,
  overlayLayerOptions,
  TILE_THEMES,
  tileLayerOptions,
} from "./tiles.ts";

/**
 * Guarda de regresión (22 sept 2026): CARTO cortó el acceso anónimo a sus
 * basemaps — verificado con `curl` en vivo, las cuatro URLs
 * `*.basemaps.cartocdn.com` que usaban estos presets devuelven 200 con un
 * tile idéntico de "API KEY REQUIRED", sin importar la URL pedida. Se
 * reemplazaron por Esri (sin clave). Este test evita que alguien reintroduzca
 * CARTO en un preset sin darse cuenta de que hoy está roto.
 */
describe("TILE_THEMES", () => {
  it("ningún preset apunta a basemaps.cartocdn.com (roto desde 22 sept 2026, sin clave)", () => {
    for (const [nombre, config] of Object.entries(TILE_THEMES)) {
      expect(config.url, `preset ${nombre}`).not.toContain("cartocdn.com");
      if (config.overlay) {
        expect(config.overlay.url, `overlay de ${nombre}`).not.toContain("cartocdn.com");
      }
    }
  });

  it("los presets 'gris limpio' (positron, positron-xl, voyager) traen capa de etiquetas de Esri", () => {
    for (const nombre of ["carto-positron", "carto-positron-xl", "carto-voyager"] as const) {
      const config = TILE_THEMES[nombre];
      expect(config.url).toContain("World_Light_Gray_Base");
      expect(config.overlay?.url).toContain("World_Light_Gray_Reference");
    }
  });

  it("carto-dark trae su propia capa de etiquetas (Dark Gray, no Light Gray)", () => {
    const config = TILE_THEMES["carto-dark"];
    expect(config.url).toContain("World_Dark_Gray_Base");
    expect(config.overlay?.url).toContain("World_Dark_Gray_Reference");
  });

  it("osm no cambió: sigue siendo el tile estándar de OpenStreetMap, sin overlay", () => {
    expect(TILE_THEMES.osm.url).toBe("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png");
    expect(TILE_THEMES.osm.overlay).toBeUndefined();
  });
});

describe("overlayLayerOptions", () => {
  it("manda al pane de etiquetas y respeta maxZoom/tileSize/zoomOffset", () => {
    const opts = overlayLayerOptions({ url: "x", maxZoom: 16, tileSize: 512, zoomOffset: -1 });
    expect(opts).toMatchObject({ pane: LABELS_PANE, maxZoom: 16, tileSize: 512, zoomOffset: -1 });
  });

  it("sin maxZoom, cae a 19 igual que tileLayerOptions", () => {
    expect(overlayLayerOptions({ url: "x" }).maxZoom).toBe(19);
  });
});

describe("ensureLabelsPane", () => {
  function fakeMap() {
    const panes = new Map<string, { style: { zIndex: string; pointerEvents: string } }>();
    return {
      getPane: vi.fn((name: string) => panes.get(name)),
      createPane: vi.fn((name: string) => {
        const pane = { style: { zIndex: "", pointerEvents: "" } };
        panes.set(name, pane);
        return pane;
      }),
    };
  }

  it("crea el pane con el z-index y pointerEvents:none esperados", () => {
    const map = fakeMap();
    ensureLabelsPane(map);
    expect(map.createPane).toHaveBeenCalledWith(LABELS_PANE);
    const pane = map.createPane.mock.results[0]!.value;
    expect(pane.style.zIndex).toBe(String(LABELS_PANE_Z_INDEX));
    expect(pane.style.pointerEvents).toBe("none");
  });

  it("es idempotente: si el pane ya existe, no lo vuelve a crear", () => {
    const map = fakeMap();
    ensureLabelsPane(map);
    ensureLabelsPane(map);
    expect(map.createPane).toHaveBeenCalledTimes(1);
  });
});

describe("tileLayerOptions (sin cambios de comportamiento)", () => {
  it("sigue sin mandar pane — la capa base va en el pane por omisión de Leaflet", () => {
    expect(tileLayerOptions(TILE_THEMES.osm).pane).toBeUndefined();
  });
});
