<?php
/**
 * Shortcode [allride_geocodificador]: monta el bundle standalone de
 * @allride/address-batch (packages/wp-embed) dentro de un contenedor con
 * la config en `data-config` — el propio bundle escanea el DOM al cargar y
 * se monta ahí solo, sin JS inline por instancia (ver
 * packages/wp-embed/src/main.tsx).
 *
 * El script y el CSS se encolan DENTRO del shortcode, no en cada carga de
 * página: son ~300 KB gzip (React + Leaflet + xlsx empaquetados, porque un
 * <script> suelto no puede resolver imports diferidos) y no tiene sentido
 * pagarlos en páginas que no usan la herramienta.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_shortcode( 'allride_geocodificador', 'allride_geo_render_shortcode' );

function allride_geo_render_shortcode( $atts ) {
	$settings = allride_geo_get_settings();

	if ( empty( $settings['api_base_url'] ) ) {
		if ( current_user_can( 'manage_options' ) ) {
			return sprintf(
				'<p>%s <a href="%s">%s</a></p>',
				esc_html__( 'Falta configurar la URL del backend de AllRide Geocodificador.', 'allride-geocodificador' ),
				esc_url( admin_url( 'options-general.php?page=allride-geocodificador' ) ),
				esc_html__( 'Configurar ahora', 'allride-geocodificador' )
			);
		}
		return '';
	}

	wp_enqueue_style(
		'allride-geo-batch',
		ALLRIDE_GEO_PLUGIN_URL . 'assets/allride-address-batch.css',
		array(),
		ALLRIDE_GEO_VERSION
	);
	wp_enqueue_script(
		'allride-geo-batch',
		ALLRIDE_GEO_PLUGIN_URL . 'assets/allride-address-batch.js',
		array(),
		ALLRIDE_GEO_VERSION,
		true
	);

	$atts = shortcode_atts(
		array(
			'max_rows' => $settings['max_rows'],
		),
		$atts,
		'allride_geocodificador'
	);

	// Sin `bias.country`: el país lo elige quien usa la herramienta, en el
	// selector obligatorio del propio widget (ver countries.ts en
	// @allride/address-batch) — acá no hay nada que fijar de antemano.
	$config = array(
		'apiBaseUrl' => $settings['api_base_url'],
		'maxRows'    => absint( $atts['max_rows'] ),
	);

	return sprintf(
		'<div class="allride-address-batch" data-config=\'%s\'></div>',
		esc_attr( wp_json_encode( $config ) )
	);
}
