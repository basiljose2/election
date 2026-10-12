"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { isCommandError } from "@/lib/commands/errors";
import { executeCommand } from "@/lib/commands/gateway";
import { eraseAllData } from "@/lib/commands/system";
import { clearMediaBucket } from "@/lib/media/store";

/** Erases all election data (test databases only). Returns to /admin/system with the outcome. */
export async function eraseAllDataAction(formData: FormData): Promise<void> {
  const confirmation = String(formData.get("confirmation") ?? "");
  let message: string;
  try {
    const counts = await executeCommand(eraseAllData, { confirmation });
    let images = 0;
    try {
      images = await clearMediaBucket();
    } catch {
      // The database is already erased; stray public images are harmless.
    }
    redirect(
      `/admin/system?ok=${encodeURIComponent(
        `All election data erased (${counts.elections} elections, ${counts.vote_selections} vote rows, ${images} images)`,
      )}`,
    );
  } catch (error) {
    unstable_rethrow(error);
    if (!isCommandError(error)) {
      console.error("erase failed", error);
      message = "Something went wrong. Nothing was changed.";
    } else if (error.code === "unauthenticated" || error.code === "mfa_required") {
      redirect("/sign-in");
    } else if (error.code === "reauth_required") {
      redirect(`/reauth?next=${encodeURIComponent("/admin/system")}`);
    } else {
      message = error.message;
    }
  }
  redirect(`/admin/system?error=${encodeURIComponent(message)}`);
}
