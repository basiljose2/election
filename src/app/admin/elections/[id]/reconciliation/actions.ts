"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { isCommandError } from "@/lib/commands/errors";
import { executeCommand } from "@/lib/commands/gateway";
import { reconcileElection } from "@/lib/reconciliation/command";

/** The Returning Officer runs the election reconciliation and returns to the report. */
export async function reconcileAction(formData: FormData): Promise<void> {
  const electionId = String(formData.get("electionId") ?? "");
  const page = `/admin/elections/${electionId}/reconciliation`;
  let message: string;
  try {
    await executeCommand(reconcileElection, { electionId });
    redirect(`${page}?ok=${encodeURIComponent("Reconciliation completed")}`);
  } catch (error) {
    unstable_rethrow(error);
    if (isCommandError(error)) {
      if (error.code === "unauthenticated" || error.code === "mfa_required") redirect("/sign-in");
      message = error.message;
    } else {
      console.error("reconciliation failed", error);
      message = "Something went wrong. Nothing was changed.";
    }
  }
  redirect(`${page}?error=${encodeURIComponent(message)}`);
}
