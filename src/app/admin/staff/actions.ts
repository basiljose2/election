"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { supabaseAuthAdmin } from "@/lib/auth/adapters";
import { isCommandError } from "@/lib/commands/errors";
import { executeCommand } from "@/lib/commands/gateway";
import { createStaffCommands } from "@/lib/commands/staff";

const commands = () => createStaffCommands(supabaseAuthAdmin());

function text(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function run(task: () => Promise<unknown>, success: string): Promise<never> {
  let message: string;
  try {
    await task();
    redirect(`/admin/staff?ok=${encodeURIComponent(success)}`);
  } catch (error) {
    unstable_rethrow(error); // let Next.js redirects through
    if (!isCommandError(error)) {
      console.error("staff command failed", error);
      message = "Something went wrong. Nothing was changed.";
    } else if (error.code === "unauthenticated" || error.code === "mfa_required") {
      redirect("/sign-in");
    } else {
      message = error.message;
    }
  }
  redirect(`/admin/staff?error=${encodeURIComponent(message)}`);
}

export async function createStaffAction(formData: FormData) {
  await run(
    () =>
      executeCommand(commands().createStaff, {
        email: text(formData, "email"),
        displayName: text(formData, "displayName"),
        password: formData.get("password"),
      }),
    "Staff account created",
  );
}

export async function deactivateStaffAction(formData: FormData) {
  await run(
    () => executeCommand(commands().deactivateStaff, { userId: text(formData, "userId") }),
    "Account deactivated",
  );
}

export async function assignRoleAction(formData: FormData) {
  await run(
    () =>
      executeCommand(commands().assignRole, {
        userId: text(formData, "userId"),
        role: text(formData, "role"),
        electionId: text(formData, "electionId"),
        boothId: text(formData, "boothId"),
      }),
    "Role assigned",
  );
}

export async function revokeRoleAction(formData: FormData) {
  await run(
    () => executeCommand(commands().revokeRole, { assignmentId: text(formData, "assignmentId") }),
    "Role revoked",
  );
}
