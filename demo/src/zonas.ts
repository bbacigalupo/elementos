import type { AdminAreaOption, GeoBias } from "@allride/geo-core";

/**
 * Configuración compartida por los dos playgrounds.
 *
 * Vive aparte y no dentro de uno de ellos porque importar una constante
 * desde el otro demo arrastraba su elemento entero al cargar la página, y
 * eso escondía qué se carga en diferido de verdad.
 */

export const ZONES: Record<string, { label: string; bias: GeoBias }> = {
  santiago: {
    label: "Santiago, CL",
    bias: { country: "CL", center: { lat: -33.4489, lng: -70.6693 }, radiusKm: 40 },
  },
  valparaiso: {
    label: "Valparaíso, CL",
    bias: { country: "CL", center: { lat: -33.0472, lng: -71.6127 }, radiusKm: 25 },
  },
  concepcion: {
    label: "Concepción, CL",
    bias: { country: "CL", center: { lat: -36.8201, lng: -73.0444 }, radiusKm: 25 },
  },
  bogota: {
    label: "Bogotá, CO",
    bias: { country: "CO", center: { lat: 4.711, lng: -74.0721 }, radiusKm: 40 },
  },
  paisSolo: {
    label: "Solo país (CL, sin centro)",
    bias: { country: "CL" },
  },
};

/** Comunas de la Región Metropolitana, del mismo catálogo que usa la encuesta. */
export const COMUNAS_RM: AdminAreaOption[] = [
  {"id": "cerrillos", "name": "Cerrillos", "parentName": "Región Metropolitana de Santiago"}, {"id": "cerro-navia", "name": "Cerro Navia", "parentName": "Región Metropolitana de Santiago"}, {"id": "conchali", "name": "Conchalí", "parentName": "Región Metropolitana de Santiago"}, {"id": "el-bosque", "name": "El Bosque", "parentName": "Región Metropolitana de Santiago"}, {"id": "estacion-central", "name": "Estación Central", "parentName": "Región Metropolitana de Santiago"}, {"id": "huechuraba", "name": "Huechuraba", "parentName": "Región Metropolitana de Santiago"}, {"id": "independencia", "name": "Independencia", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-cisterna", "name": "La Cisterna", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-florida", "name": "La Florida", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-granja", "name": "La Granja", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-pintana", "name": "La Pintana", "parentName": "Región Metropolitana de Santiago"}, {"id": "la-reina", "name": "La Reina", "parentName": "Región Metropolitana de Santiago"}, {"id": "las-condes", "name": "Las Condes", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-barnechea", "name": "Lo Barnechea", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-espejo", "name": "Lo Espejo", "parentName": "Región Metropolitana de Santiago"}, {"id": "lo-prado", "name": "Lo Prado", "parentName": "Región Metropolitana de Santiago"}, {"id": "macul", "name": "Macul", "parentName": "Región Metropolitana de Santiago"}, {"id": "maipu", "name": "Maipú", "parentName": "Región Metropolitana de Santiago"}, {"id": "nunoa", "name": "Ñuñoa", "parentName": "Región Metropolitana de Santiago"}, {"id": "pedro-aguirre-cerda", "name": "Pedro Aguirre Cerda", "parentName": "Región Metropolitana de Santiago"}, {"id": "penalolen", "name": "Peñalolén", "parentName": "Región Metropolitana de Santiago"}, {"id": "providencia", "name": "Providencia", "parentName": "Región Metropolitana de Santiago"}, {"id": "pudahuel", "name": "Pudahuel", "parentName": "Región Metropolitana de Santiago"}, {"id": "quilicura", "name": "Quilicura", "parentName": "Región Metropolitana de Santiago"}, {"id": "quinta-normal", "name": "Quinta Normal", "parentName": "Región Metropolitana de Santiago"}, {"id": "recoleta", "name": "Recoleta", "parentName": "Región Metropolitana de Santiago"}, {"id": "renca", "name": "Renca", "parentName": "Región Metropolitana de Santiago"}, {"id": "santiago", "name": "Santiago", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-joaquin", "name": "San Joaquín", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-miguel", "name": "San Miguel", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-ramon", "name": "San Ramón", "parentName": "Región Metropolitana de Santiago"}, {"id": "vitacura", "name": "Vitacura", "parentName": "Región Metropolitana de Santiago"}, {"id": "puente-alto", "name": "Puente Alto", "parentName": "Región Metropolitana de Santiago"}, {"id": "pirque", "name": "Pirque", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-jose-de-maipo", "name": "San José de Maipo", "parentName": "Región Metropolitana de Santiago"}, {"id": "colina", "name": "Colina", "parentName": "Región Metropolitana de Santiago"}, {"id": "lampa", "name": "Lampa", "parentName": "Región Metropolitana de Santiago"}, {"id": "tiltil", "name": "Tiltil", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-bernardo", "name": "San Bernardo", "parentName": "Región Metropolitana de Santiago"}, {"id": "buin", "name": "Buin", "parentName": "Región Metropolitana de Santiago"}, {"id": "calera-de-tango", "name": "Calera de Tango", "parentName": "Región Metropolitana de Santiago"}, {"id": "paine", "name": "Paine", "parentName": "Región Metropolitana de Santiago"}, {"id": "melipilla", "name": "Melipilla", "parentName": "Región Metropolitana de Santiago"}, {"id": "alhue", "name": "Alhué", "parentName": "Región Metropolitana de Santiago"}, {"id": "curacavi", "name": "Curacaví", "parentName": "Región Metropolitana de Santiago"}, {"id": "maria-pinto", "name": "María Pinto", "parentName": "Región Metropolitana de Santiago"}, {"id": "san-pedro", "name": "San Pedro", "parentName": "Región Metropolitana de Santiago"}, {"id": "talagante", "name": "Talagante", "parentName": "Región Metropolitana de Santiago"}, {"id": "el-monte", "name": "El Monte", "parentName": "Región Metropolitana de Santiago"}, {"id": "isla-de-maipo", "name": "Isla de Maipo", "parentName": "Región Metropolitana de Santiago"}, {"id": "padre-hurtado", "name": "Padre Hurtado", "parentName": "Región Metropolitana de Santiago"}, {"id": "penaflor", "name": "Peñaflor", "parentName": "Región Metropolitana de Santiago"}
];
