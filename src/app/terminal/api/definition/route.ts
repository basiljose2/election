import { cookies } from "next/headers";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { TERMINAL_COOKIES } from "@/lib/terminals/credentials";
import { guardTerminal } from "@/lib/terminals/guard";
import { fetchBoothDefinition } from "@/lib/votes/casting";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** The booth's Ballot Definition (public after freeze) for preloading on the Voting Terminal. */
export async function GET() {
  const presented = (await cookies()).get(TERMINAL_COOKIES.voting.name)?.value;
  const guard = await guardTerminal(
    { db: getPool(), appendAudit: appendAuditEvent },
    presented,
    { type: "voting" },
    "/terminal/api/definition",
  );
  if (!guard.ok) return json(guard.status, { error: guard.error });

  const definition = await fetchBoothDefinition({ db: getPool() }, guard.terminal);
  if (!definition) return json(404, { error: "not_found" });
  return json(200, definition);
}
