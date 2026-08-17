<?php
/**
 * Plugin Name: AllRide Geocodificador
 * Description: Convierte direcciones a coordenadas GPS en lote. Shortcode [allride_geocodificador].
 * Version: 1.1.0
 * Author: AllRide
 * Text Domain: allride-geocodificador
 *
 * Reemplaza al plugin anterior (v1.0.9, sobre Nominatim, tope de 100 y
 * reporte solo OK/Err): este separa lo exitoso de lo que hay que revisar en
 * vez de marcar todo "OK" cuando el proveedor encontró la calle pero no la
 * altura. El motor real vive fuera de WordPress — este plugin solo aloja el
 * shortcode y encola el bundle ya construido; el proxy que geocodifica de
 * verdad está en packages/wp-geocoder-api del monorepo (Vercel).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'ALLRIDE_GEO_VERSION', '1.1.0' );
define( 'ALLRIDE_GEO_PLUGIN_FILE', __FILE__ );
define( 'ALLRIDE_GEO_PLUGIN_DIR', plugin_dir_path( __FILE__ ) );
define( 'ALLRIDE_GEO_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once ALLRIDE_GEO_PLUGIN_DIR . 'includes/settings.php';
require_once ALLRIDE_GEO_PLUGIN_DIR . 'includes/shortcode.php';
