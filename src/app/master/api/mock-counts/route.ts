import { cookies } from "next/headers";
import { appendAuditEvent } from "@/lib/audit/append";
import { requireActorForCommand } from "@/lib/auth/current-actor";
import { isCommandError } from "@/lib/commands/errors";
import { getPool } from "@/lib/db/pool";
import { TERMINAL_COOKIES } from "@/lib/terminals/credentials";
import { guardTerminal } from "@/lib/terminals/guard";
import { getMockCounts } from "@/lib/votes/mock-counts";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Mock counts of the current mock round: the booth's Presiding Officer on its Master Terminal. */
export async function GET() {
  const presented = (await cookies()).get(TERMINAL_COOKIES.master.name)?.value;
  const guard = await guardTerminal(
    { db: getPool(), appendAudit: appendAuditEvent },
    presented,
    { type: "master" },
    "/master/api/mock-counts",
  );
  if (!guard.ok) return json(guard.status, { error: guard.error });

  try {
    const actor = await requireActorForCommand();
    return json(200, await getMockCounts(getPool(), actor, guard.terminal.boothId));
  } catch (error) {
    if (isCommandError(error)) {
      return json(error.code === "forbidden" ? 403 : 401, { error: error.code });
    }
    throw error;
  }
}
