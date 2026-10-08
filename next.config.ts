import type { NextConfig } from "next";
import { SECURITY_HEADERS, STATIC_ASSET_CSP } from "./src/lib/security/headers";

const staticHeaders = [
  ...SECURITY_HEADERS.map(([key, value]) => ({ key, value })),
  { key: "Content-Security-Policy", value: STATIC_ASSET_CSP },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Every page is dynamic, so few build workers are needed; this keeps memory low on
    // CI runners and dev machines that also run the Supabase containers.
    cpus: Number(process.env.NEXT_BUILD_CPUS ?? 2),
  },
  // Pages and API routes get their headers (with a per-request CSP nonce) from src/proxy.ts.
  // These cover the static files that the proxy skips.
  async headers() {
    return [
      { source: "/_next/static/:path*", headers: staticHeaders },
      { source: "/_next/image", headers: staticHeaders },
      { source: "/favicon.ico", headers: staticHeaders },
      { source: "/robots.txt", headers: staticHeaders },
    ];
  },
};

export default nextConfig;
