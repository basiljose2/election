import { cookies } from "next/headers";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { TERMINAL_COOKIES } from "@/lib/terminals/credentials";
import { guardTerminal } from "@/lib/terminals/guard";
import { fetchPendingBallot } from "@/lib/votes/casting";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * The bound Voting Terminal asks for its pending ballot: the booth's Ballot Definition and a
 * single-use cast token. Any other device, or a terminal of another booth, is refused.
 */
export async function GET() {
  const presented = (await cookies()).get(TERMINAL_COOKIES.voting.name)?.value;
  const guard = await guardTerminal(
    { db: getPool(), appendAudit: appendAuditEvent },
    presented,
    { type: "voting" },
    "/terminal/api/ballot",
  );
  if (!guard.ok) return json(guard.status, { error: guard.error });

  const pending = await fetchPendingBallot({ db: getPool() }, guard.terminal);
  if (pending.status === "forbidden") return json(403, { error: "forbidden" });
  if (pending.status === "none") return json(200, { status: "none" });
  return json(200, pending);
}
