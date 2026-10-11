import { logger } from "@/lib/log";

/**
 * Server-side error reporting hook. Every unhandled request error is written through the
 * allowlisting logger: the route and an error code only. The error object, its message and
 * the request body are never logged (a message can embed a query parameter or an id).
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath?: string; routeType?: string },
) {
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : "unknown";
  logger.error("request.error", {
    route: context.routePath ?? request.path.split("?")[0],
    error_code: /^[A-Za-z0-9_-]{1,40}$/.test(digest) ? digest : "unknown",
    status: 500,
  });
}
