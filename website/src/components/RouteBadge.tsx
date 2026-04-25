import type { Route } from 'gtfs-sqljs';
import { asHex, readableTextColor } from '../util/contrast';

export function RouteBadge({ route }: { route: Route }) {
  const bg = asHex(route.route_color, '#374151');
  const fg = route.route_text_color
    ? asHex(route.route_text_color, readableTextColor(route.route_color))
    : readableTextColor(route.route_color);
  const label = route.route_short_name || route.route_long_name || route.route_id;
  const tooltip = route.route_long_name
    ? `${route.route_long_name}${route.route_short_name ? ` (${route.route_short_name})` : ''}`
    : label;
  return (
    <span className="route-badge" style={{ backgroundColor: bg, color: fg }} title={tooltip}>
      {label}
    </span>
  );
}
