import { z } from "zod";
import type { JsonValue } from "@/lib/audit/canonical-json";
import { defineCommand } from "@/lib/commands/gateway";
import { describeElection, returningOfficerGrant, uuid } from "@/lib/commands/setup-common";
import { fail, pass, type GuardRegistry } from "@/lib/lifecycle/guards";
import {
  reportAuditDetail,
  runReconciliation,
  storeReconciliation,
  type ReconciliationReport,
} from "./run";

/**
 * The Returning Officer runs the election reconciliation (the declare screen does this when it
 * opens). The full report is stored; the Audit Event records each check's outcome.
 */
export const reconcileElection = defineCommand({
  name: "election.reconciled",
  input: z.object({ electionId: uuid }),
  authorize: (actor, input) => returningOfficerGrant(actor, input.electionId),
  describeTarget: describeElection,
  async execute(ctx, input) {
    const report = await runReconciliation(ctx.tx, {
      electionId: input.electionId,
      now: ctx.now(),
    });
    const runId = await storeReconciliation(ctx.tx, report, ctx.actor.userId);
    return {
      result: { runId, report } as { runId: string; report: ReconciliationReport },
      audit: {
        electionId: input.electionId,
        target: { type: "election", id: input.electionId },
        before: null,
        after: { run_id: runId, election_checks_passed: report.electionChecksPassed },
        detail: reportAuditDetail(report) as unknown as JsonValue,
      },
    };
  },
});

/**
 * Declaring results re-runs the reconciliation inside the declare transaction, so the report
 * that justifies a declaration is the one from that very transaction. Election-wide failures
 * (audit chain, setup, pending sessions) block the declaration outright; a failing booth only
 * fails the Posts mapped to it, which results are withheld for (see `reconciliationPassed`).
 */
export const reconciliationGuards: GuardRegistry = {
  async reconciliationPassed(ctx) {
    const report = await runReconciliation(ctx.tx, { electionId: ctx.electionId, now: ctx.now });
    await storeReconciliation(ctx.tx, report, ctx.actor.userId);
    const failed = report.electionChecks.filter((c) => !c.passed);
    if (failed.length > 0) {
      return fail(
        `the election reconciliation failed: ${failed.map((c) => c.check.replace(/_/g, " ")).join(", ")}`,
      );
    }
    return pass(reportAuditDetail(report) as unknown as JsonValue);
  },
};
