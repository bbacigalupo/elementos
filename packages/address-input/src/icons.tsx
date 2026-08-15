/**
 * Íconos de línea (trazo 1.75, extremos y uniones redondeados, grilla 24)
 * para mantener el mismo peso visual en todo el elemento. Son SVG inline y
 * heredan `currentColor`: sin dependencias, sin requests, y se tiñen con el
 * color del botón que los contiene.
 */

interface IconProps {
  /** Tamaño en px del lado del cuadro. */
  size?: number;
  className?: string;
}

function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** Lupa: búsqueda explícita del texto escrito. */
export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </Svg>
  );
}

/** Pin sobre mapa: ubicar marcando el punto. */
export function IconMapPin(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" />
      <circle cx="12" cy="10" r="2.5" />
    </Svg>
  );
}

/** Mira/retícula: centrar en la ubicación actual. */
export function IconCrosshair(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </Svg>
  );
}

/** Coordenadas manuales. */
export function IconCoordinates(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5v17" />
    </Svg>
  );
}

/** Limpiar el texto escrito. */
export function IconX(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  );
}
