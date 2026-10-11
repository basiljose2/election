"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { isCommandError } from "@/lib/commands/errors";
import { createBallotCommands } from "@/lib/commands/ballots";
import { executeCommand } from "@/lib/commands/gateway";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { getSignalPublisher } from "@/lib/signals/server";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** Runs one command and returns to `page` with an ok/error message (or on to `successPage`). */
async function run(
  electionId: string,
  task: () => Promise<unknown>,
  success: string,
  successPage?: string,
): Promise<never> {
  const page = `/admin/elections/${electionId}/dashboard`;
  let message: string;
  try {
    await task();
    redirect(successPage ?? `${page}?ok=${encodeURIComponent(success)}`);
  } catch (error) {
    unstable_rethrow(error);
    if (!isCommandError(error)) {
      console.error("election command failed", error);
      message = "Something went wrong. Nothing was changed.";
    } else if (error.code === "unauthenticated" || error.code === "mfa_required") {
      redirect("/sign-in");
    } else if (error.code === "reauth_required") {
      redirect(`/reauth?next=${encodeURIComponent(page)}`);
    } else {
      message = error.message;
    }
  }
  redirect(`${page}?error=${encodeURIComponent(message)}`);
}

export async function completePollsAction(formData: FormData): Promise<void> {
  const electionId = field(formData, "electionId");
  const lifecycle = createAppLifecycle(await getSignalPublisher());
  await run(
    electionId,
    () => executeCommand(lifecycle.completePolls, { electionId }),
    "All polls completed",
  );
}

export async function forceCloseAction(formData: FormData): Promise<void> {
  const electionId = field(formData, "electionId");
  const lifecycle = createAppLifecycle(await getSignalPublisher());
  await run(
    electionId,
    () =>
      executeCommand(lifecycle.forceClosePoll, {
        electionId,
        boothId: field(formData, "boothId"),
        reason: field(formData, "reason"),
      }),
    "Booth force-closed",
  );
}

export async function declareResultsAction(formData: FormData): Promise<void> {
  const electionId = field(formData, "electionId");
  const lifecycle = createAppLifecycle(await getSignalPublisher());
  await run(
    electionId,
    () => executeCommand(lifecycle.declareResults, { electionId }),
    "Results declared",
    `/admin/elections/${electionId}/results`,
  );
}

/**
 * The Returning Officer cancels a pending ballot when the booth's Master Terminal cannot
 * (it failed, or its Presiding Officer is unreachable).
 */
export async function cancelPendingBallotAction(formData: FormData): Promise<void> {
  const electionId = field(formData, "electionId");
  const ballots = createBallotCommands(await getSignalPublisher());
  await run(
    electionId,
    () =>
      executeCommand(ballots.cancelPendingBallotAsOfficer, {
        electionId,
        boothId: field(formData, "boothId"),
        note: field(formData, "note"),
      }),
    "Pending ballot cancelled",
  );
}
