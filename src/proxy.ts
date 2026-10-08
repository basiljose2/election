import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_OPTIONS } from "@/lib/auth/cookies";
import { buildCsp, createNonce, SECURITY_HEADERS } from "@/lib/security/headers";

interface PendingCookie {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/**
 * Runs before every non-static request:
 * - sets a nonce-based CSP and the baseline security headers;
 * - refreshes the Supabase session cookies (HttpOnly) when they are present.
 * Authorization is NOT decided here; every page, action and route checks it on the server.
 */
export async function proxy(request: NextRequest) {
  const nonce = createNonce();
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    upgradeInsecure: Boolean(process.env.VERCEL_ENV),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);

  const pending: PendingCookie[] = [];
  const hasSession = request.cookies.getAll().some((c) => c.name.startsWith("sb-"));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

  if (hasSession && supabaseUrl && supabaseKey) {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookieOptions: AUTH_COOKIE_OPTIONS,
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const cookie of toSet) {
            request.cookies.set(cookie.name, cookie.value);
            pending.push(cookie);
          }
        },
      },
    });
    // Verifies the token and refreshes it if it has expired.
    await supabase.auth.getClaims();
    if (pending.length) requestHeaders.set("cookie", request.cookies.toString());
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const { name, value, options } of pending) {
    response.cookies.set(name, value, { ...options, ...AUTH_COOKIE_OPTIONS });
  }
  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
