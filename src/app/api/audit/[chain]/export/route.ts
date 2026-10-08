import { z } from "zod";
import { appendAuditEvent } from "@/lib/audit/append";
import { buildAuditExport, serializeAuditExport } from "@/lib/audit/export";
import { getActorResolution } from "@/lib/auth/current-actor";
import { electionGrant, superAdminGrant, type Actor } from "@/lib/auth/roles";
import { recordDeniedAttempt } from "@/lib/commands/gateway";
import { getPool } from "@/lib/db/pool";

const chainParam = z.union([z.literal("system"), z.uuid()]);

function json(status: number, body: object) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Super Admin: any chain. Returning Officer / Observer: their Election's chain. */
function canExport(actor: Actor, electionId: string | null): boolean {
  if (superAdminGrant(actor)) return true;
  return (
    electionId !== null &&
    electionGrant(actor, electionId, ["returning_officer", "observer"]) !== null
  );
}

export async function GET(
  _request: Request,
  { params }: RouteContext<"/api/audit/[chain]/export">,
) {
  const parsed = chainParam.safeParse((await params).chain);
  if (!parsed.success) return json(400, { error: "chain must be 'system' or an election id" });
  const electionId = parsed.data === "system" ? null : parsed.data;

  const resolution = await getActorResolution();
  if (resolution.status === "mfa_required") return json(401, { error: "mfa_required" });
  if (resolution.status !== "ok") return json(401, { error: "unauthenticated" });

  if (!canExport(resolution.actor, electionId)) {
    await recordDeniedAttempt(
      { db: getPool(), appendAudit: appendAuditEvent },
      resolution.actor,
      "audit.export",
      {
        electionId,
        target: { type: "audit_chain", id: electionId ?? "system" },
      },
    );
    return json(403, { error: "forbidden" });
  }

  const doc = await buildAuditExport(getPool(), electionId);
  return new Response(serializeAuditExport(doc), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-${electionId ?? "system"}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
