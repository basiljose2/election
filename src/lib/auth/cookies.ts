/**
 * Options forced onto every Supabase Auth cookie. The browser never talks to Supabase
 * directly, so no script needs to read these cookies.
 */
export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  path: "/",
} as const;
