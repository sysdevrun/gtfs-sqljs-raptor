import type { Interchange } from 'raptor-journey-planner';

/**
 * Wrap an Interchange map in a Proxy so that any stop_id not explicitly listed
 * resolves to a default interchange time (in seconds). Without this, raptor's
 * RouteScanner reads `undefined`, which propagates as NaN through arrival times
 * and breaks the algorithm. Iteration semantics (Object.keys, for-in) are
 * unchanged because the Proxy never claims keys it didn't already have.
 */
export function withDefaultInterchange(
  base: Record<string, number>,
  defaultSeconds = 0,
): Interchange {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'symbol') return (target as Record<string | symbol, unknown>)[prop];
      if (prop in target) return target[prop];
      return defaultSeconds;
    },
  });
}
