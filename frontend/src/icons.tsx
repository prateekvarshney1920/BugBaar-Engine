/*
 * One icon set for the whole interface.
 *
 * Inline SVG rather than an icon package: the app needs about twenty glyphs,
 * and a dependency for that would be more weight than the icons themselves.
 * Drawing them here also guarantees a single visual style — uniform stroke,
 * grid, and cap — which mixing libraries tends to lose.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function svg(path: React.ReactNode, { size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export const Icon = {
  overview: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>,
      p,
    ),

  agents: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="4" y="7" width="16" height="12" rx="3" />
        <path d="M12 3v4M9 13h.01M15 13h.01" />
        <path d="M2 12v3M22 12v3" />
      </>,
      p,
    ),

  play: (p: IconProps = {}) => svg(<path d="M6 4l14 8-14 8V4z" />, p),

  runs: (p: IconProps = {}) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </>,
      p,
    ),

  workflows: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="3" y="3" width="6" height="5" rx="1.5" />
        <rect x="15" y="16" width="6" height="5" rx="1.5" />
        <rect x="3" y="16" width="6" height="5" rx="1.5" />
        <path d="M6 8v5a3 3 0 003 3h3M18 16v-3a3 3 0 00-3-3h-3" />
      </>,
      p,
    ),

  knowledge: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M4 5.5A2.5 2.5 0 016.5 3H19v15H6.5A2.5 2.5 0 004 20.5z" />
        <path d="M4 18.5A2.5 2.5 0 016.5 16H19v5H6.5" />
      </>,
      p,
    ),

  monitoring: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M3 12h4l2.5-7 4 14 2.5-7h5" />
      </>,
      p,
    ),

  developer: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M9 17l-5-5 5-5M15 7l5 5-5 5" />
      </>,
      p,
    ),

  tool: (p: IconProps = {}) =>
    svg(<path d="M14.5 6.5a4 4 0 01-5.3 5.3L4 17v3h3l5.2-5.2a4 4 0 015.3-5.3l-2.6 2.6-2-2z" />, p),

  search: (p: IconProps = {}) =>
    svg(
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </>,
      p,
    ),

  plus: (p: IconProps = {}) => svg(<path d="M12 5v14M5 12h14" />, p),

  check: (p: IconProps = {}) => svg(<path d="M4 12.5l5 5L20 6.5" />, p),

  x: (p: IconProps = {}) => svg(<path d="M6 6l12 12M18 6L6 18" />, p),

  alert: (p: IconProps = {}) =>
    svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5v5M12 16h.01" />
      </>,
      p,
    ),

  trash: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
      </>,
      p,
    ),

  stop: (p: IconProps = {}) => svg(<rect x="6" y="6" width="12" height="12" rx="2" />, p),

  refresh: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M20 11a8 8 0 10-2.3 5.7" />
        <path d="M20 5v6h-6" />
      </>,
      p,
    ),

  chevron: (p: IconProps = {}) => svg(<path d="M9 6l6 6-6 6" />, p),

  panel: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>,
      p,
    ),

  database: (p: IconProps = {}) =>
    svg(
      <>
        <ellipse cx="12" cy="6" rx="8" ry="3" />
        <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
        <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
      </>,
      p,
    ),

  queue: (p: IconProps = {}) =>
    svg(
      <>
        <rect x="3" y="4" width="18" height="5" rx="1.5" />
        <rect x="3" y="13" width="18" height="5" rx="1.5" />
        <path d="M7 20h10" />
      </>,
      p,
    ),

  bolt: (p: IconProps = {}) => svg(<path d="M13 2L5 13h6l-1 9 8-11h-6l1-9z" />, p),

  doc: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
        <path d="M14 3v5h5" />
      </>,
      p,
    ),

  inbox: (p: IconProps = {}) =>
    svg(
      <>
        <path d="M3 12h5l2 3h4l2-3h5" />
        <path d="M5.5 5h13l2.5 7v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6z" />
      </>,
      p,
    ),
};

export type IconName = keyof typeof Icon;
