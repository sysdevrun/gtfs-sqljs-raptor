/**
 * Wrap a feed URL with the gtfs-proxy.sys-dev-run.re CORS proxy when needed.
 * The proxy only supports https sources; http URLs are left alone (and will
 * likely fail in the browser if the host doesn't set CORS).
 */
export function getProxyUrl(httpsUrl: string): string {
  if (!httpsUrl.startsWith('https://')) return httpsUrl;
  return `https://gtfs-proxy.sys-dev-run.re/proxy/${httpsUrl.slice('https://'.length)}`;
}
