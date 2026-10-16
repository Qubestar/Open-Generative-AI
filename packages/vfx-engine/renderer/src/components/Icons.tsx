import React from 'react';

// Minimal stroke icon set for diagram-based concept graphics.
// Director payloads reference these by keyword (item.icon / payload.icon).

const PATHS: Record<string, JSX.Element> = {
  pencil: (
    <g>
      <path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z" />
      <path d="M14.5 6.5l3 3" />
    </g>
  ),
  person: (
    <g>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c1.2-3.6 4-5 7-5s5.8 1.4 7 5" />
    </g>
  ),
  trash: (
    <g>
      <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
      <path d="M6.5 7l1 13h9l1-13" />
      <path d="M10 11v5M14 11v5" />
    </g>
  ),
  gear: (
    <g>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.8v3M12 18.2v3M21.2 12h-3M5.8 12h-3M18.5 5.5l-2.1 2.1M7.6 16.4l-2.1 2.1M18.5 18.5l-2.1-2.1M7.6 7.6L5.5 5.5" />
    </g>
  ),
  doc: (
    <g>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </g>
  ),
  chart: (
    <g>
      <path d="M4 20h16" />
      <path d="M7 20v-6M12 20V8M17 20v-10" />
    </g>
  ),
  funnel: (
    <g>
      <path d="M4 5h16l-6 7v6l-4 2v-8L4 5z" />
    </g>
  ),
  rocket: (
    <g>
      <path d="M12 3c3.5 1.5 5.5 5 5.5 8.5L14 15h-4l-3.5-3.5C6.5 8 8.5 4.5 12 3z" />
      <circle cx="12" cy="9" r="1.6" />
      <path d="M9 16l-2 5 4-2M15 16l2 5-4-2" />
    </g>
  ),
  money: (
    <g>
      <rect x="3" y="7" width="18" height="11" rx="2" />
      <circle cx="12" cy="12.5" r="2.6" />
      <path d="M6.5 10v.01M17.5 15v.01" />
    </g>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  link: (
    <g>
      <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 10-5.7-5.7l-1.2 1.2" />
      <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 105.7 5.7l1.2-1.2" />
    </g>
  ),
  download: (
    <g>
      <path d="M12 3v10m0 0l-4-4m4 4l4-4" />
      <path d="M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
    </g>
  ),
};

export const Icon = ({
  name,
  size,
  color,
  strokeWidth = 2.1,
  style,
}: {
  name?: string;
  size: number;
  color: string;
  strokeWidth?: number;
  style?: React.CSSProperties;
}) => {
  const glyph = PATHS[name ?? ''] ?? PATHS.doc;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {glyph}
    </svg>
  );
};
