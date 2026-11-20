// Security headers of the web app's pages, wherever they are served from.

/**
 * Headers for every UI response. `connectSrc` is the CSP connect-src: where the page may send
 * requests (its own origin for the CLI's bundled UI; the CLI on 127.0.0.1 too for the hosted app).
 */
export function uiSecurityHeaders(connectSrc: string): Record<string, string> {
  return {
    "Content-Security-Policy": `script-src 'self'; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * The hosted app's `_headers` file (Cloudflare's format: a path pattern, then its headers
 * indented), which the web build emits next to the UI.
 */
export function hostedHeadersFile(): string {
  const headers = uiSecurityHeaders("'self' http://127.0.0.1:*");
  return ["/*", ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`), ""].join(
    "\n",
  );
}
