/**
 * Baseline security headers. The CSP carries a per-request nonce and is set by the proxy
 * (src/proxy.ts); static assets, which the proxy skips, get STATIC_ASSET_CSP instead.
 */

export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "no-referrer"],
  [
    "Permissions-Policy",
    "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), " +
      "magnetometer=(), microphone=(), payment=(), publickey-credentials-get=(), usb=(), " +
      "xr-spatial-tracking=()",
  ],
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["X-DNS-Prefetch-Control", "off"],
];

export const STATIC_ASSET_CSP = "default-src 'none'; frame-ancestors 'none'";

export function buildCsp(
  nonce: string,
  options: { dev: boolean; upgradeInsecure: boolean },
): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'${options.dev ? " 'unsafe-inline'" : ""}`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${options.dev ? " ws:" : ""}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (options.upgradeInsecure) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function createNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
