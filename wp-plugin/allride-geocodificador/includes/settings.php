<?php
/**
 * Página de configuración: Ajustes → AllRide Geocodificador.
 *
 * Un solo dato es realmente obligatorio (la URL del backend) — el resto
 * trae valores por defecto razonables para no obligar a completar un
 * formulario largo antes de poder usar el shortcode.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const ALLRIDE_GEO_OPTION = 'allride_geo_settings';

/**
 * Sin campo de país a propósito: quien usa el shortcode lo elige en la
 * propia herramienta (selector obligatorio, sin default) — una herramienta
 * pública puede llegar a gente de cualquier país, y fijar uno acá degradaría
 * en silencio los resultados de quien no sea de ese país.
 */
function allride_geo_default_settings() {
	return array(
		'api_base_url' => 'https://wp-geocoder-api.vercel.app/api/geo',
		'max_rows'     => 100,
	);
}

function allride_geo_get_settings() {
	$saved = get_option( ALLRIDE_GEO_OPTION, array() );
	return wp_parse_args( $saved, allride_geo_default_settings() );
}

add_action( 'admin_menu', 'allride_geo_register_settings_page' );
function allride_geo_register_settings_page() {
	add_options_page(
		__( 'AllRide Geocodificador', 'allride-geocodificador' ),
		__( 'AllRide Geocodificador', 'allride-geocodificador' ),
		'manage_options',
		'allride-geocodificador',
		'allride_geo_render_settings_page'
	);
}

add_action( 'admin_init', 'allride_geo_register_settings' );
function allride_geo_register_settings() {
	register_setting(
		'allride_geo_settings_group',
		ALLRIDE_GEO_OPTION,
		'allride_geo_sanitize_settings'
	);

	add_settings_section(
		'allride_geo_main_section',
		'',
		'__return_false',
		'allride-geocodificador'
	);

	add_settings_field(
		'api_base_url',
		__( 'URL del backend', 'allride-geocodificador' ),
		'allride_geo_field_api_base_url',
		'allride-geocodificador',
		'allride_geo_main_section'
	);

	add_settings_field(
		'max_rows',
		__( 'Máximo de direcciones por lote', 'allride-geocodificador' ),
		'allride_geo_field_max_rows',
		'allride-geocodificador',
		'allride_geo_main_section'
	);
}

function allride_geo_sanitize_settings( $input ) {
	$defaults = allride_geo_default_settings();
	$output   = array();

	$output['api_base_url'] = isset( $input['api_base_url'] ) ? esc_url_raw( trim( $input['api_base_url'] ) ) : $defaults['api_base_url'];

	$max_rows = isset( $input['max_rows'] ) ? absint( $input['max_rows'] ) : $defaults['max_rows'];
	$output['max_rows'] = $max_rows > 0 ? $max_rows : $defaults['max_rows'];

	if ( empty( $output['api_base_url'] ) ) {
		add_settings_error(
			ALLRIDE_GEO_OPTION,
			'api_base_url_empty',
			__( 'Falta la URL del backend: sin ella el shortcode no puede geocodificar.', 'allride-geocodificador' )
		);
	}

	return $output;
}

function allride_geo_field_api_base_url() {
	$settings = allride_geo_get_settings();
	?>
	<input
		type="url"
		name="<?php echo esc_attr( ALLRIDE_GEO_OPTION ); ?>[api_base_url]"
		value="<?php echo esc_attr( $settings['api_base_url'] ); ?>"
		class="regular-text"
		placeholder="https://geo.allrideapp.com/api/geo"
	/>
	<p class="description">
		<?php esc_html_e( 'El backend desplegado en Vercel (packages/wp-geocoder-api). No es la clave de LocationIQ — esa vive solo del lado del backend.', 'allride-geocodificador' ); ?>
	</p>
	<?php
}

function allride_geo_field_max_rows() {
	$settings = allride_geo_get_settings();
	?>
	<input
		type="number"
		name="<?php echo esc_attr( ALLRIDE_GEO_OPTION ); ?>[max_rows]"
		value="<?php echo esc_attr( $settings['max_rows'] ); ?>"
		class="small-text"
		min="1"
	/>
	<p class="description">
		<?php esc_html_e( 'Tope de direcciones por lote en esta herramienta gratuita.', 'allride-geocodificador' ); ?>
	</p>
	<?php
}

function allride_geo_render_settings_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'AllRide Geocodificador', 'allride-geocodificador' ); ?></h1>
		<p><?php esc_html_e( 'Inserta el shortcode [allride_geocodificador] en cualquier página o entrada.', 'allride-geocodificador' ); ?></p>
		<p>
			<?php
			// A propósito visible acá y no solo en la lista de Plugins: si
			// alguien reporta un error, la versión que hay que pedirle está a
			// un vistazo, sin que tenga que ir a buscarla a otro lado.
			printf(
				/* translators: %s: número de versión del plugin (ej. 1.1.0) */
				esc_html__( 'Versión %s', 'allride-geocodificador' ),
				esc_html( ALLRIDE_GEO_VERSION )
			);
			?>
		</p>
		<form action="options.php" method="post">
			<?php
			settings_fields( 'allride_geo_settings_group' );
			do_settings_sections( 'allride-geocodificador' );
			submit_button();
			?>
		</form>
	</div>
	<?php
}
