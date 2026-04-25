/**
 * Pick a readable text color (#000 or #fff) for a given background hex.
 * GTFS route_color is a 6-char hex without leading '#'.
 */
export function readableTextColor(hexOrEmpty?: string | null): string {
  const fallback = '#ffffff';
  if (!hexOrEmpty) return fallback;
  const hex = hexOrEmpty.replace('#', '');
  if (hex.length !== 6) return fallback;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return fallback;
  // sRGB relative luminance (per WCAG 2.x)
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.55 ? '#111111' : '#ffffff';
}

export function asHex(input?: string | null, fallback = '#374151'): string {
  if (!input) return fallback;
  const v = input.replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return fallback;
  return `#${v}`;
}
