import { cookies } from "next/headers";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/log";
import { TERMINAL_COOKIES } from "@/lib/terminals/credentials";
import { guardTerminal } from "@/lib/terminals/guard";
import { castBallot, logCastFailure } from "@/lib/votes/casting";
import { castingDeps } from "@/lib/votes/server";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Casts the voter's ballot. The request body holds the voter's choices, so this handler never
 * logs it, never echoes it, and answers with a status only. Errors are logged as codes.
 */
export async function POST(request: Request) {
  const presented = (await cookies()).get(TERMINAL_COOKIES.voting.name)?.value;
  const guard = await guardTerminal(
    { db: getPool(), appendAudit: appendAuditEvent },
    presented,
    { type: "voting" },
    "/terminal/api/cast",
  );
  if (!guard.ok) return json(guard.status, { error: guard.error });

  const body = (await request.json().catch(() => null)) as {
    castToken?: unknown;
    idempotencyKey?: unknown;
    answers?: unknown;
  } | null;
  if (!body) return json(400, { status: "rejected", reason: "bad_request" });

  try {
    const result = await castBallot(await castingDeps(), guard.terminal, {
      castToken: body.castToken,
      idempotencyKey: body.idempotencyKey,
      answers: body.answers,
    });
    if (result.status === "cast") return json(200, { status: "cast" });
    logCastFailure(guard.terminal, result);
    if (result.status === "invalid") return json(422, { status: "invalid", issues: result.issues });
    return json(409, { status: "rejected", reason: result.reason });
  } catch (error) {
    // Never include the error object: its message could carry query parameters. The class
    // name and the database error code identify the failure without carrying any data.
    logger.error("cast.error", {
      booth_id: guard.terminal.boothId,
      terminal_id: guard.terminal.id,
      error_code: `cast_failed:${error instanceof Error ? error.constructor.name : "unknown"}:${String((error as { code?: unknown }).code ?? "")}`,
    });
    return json(500, { status: "error" });
  }
}
