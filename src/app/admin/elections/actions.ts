"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { isCommandError } from "@/lib/commands/errors";
import { cloneElection, createElection, updateElection } from "@/lib/commands/election";
import { freezeSetup, unfreezeSetup } from "@/lib/commands/freeze";
import { executeCommand } from "@/lib/commands/gateway";
import {
  createBooth,
  createCandidate,
  createMediaCommands,
  createPost,
  deleteBooth,
  deleteCandidate,
  deletePost,
  reorderCandidates,
  reorderPosts,
  setBoothPosts,
  updateBooth,
  updateCandidate,
  updatePost,
} from "@/lib/commands/setup";
import { supabaseImageStore } from "@/lib/media/store";

function text(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function list(formData: FormData, name: string): string[] {
  return formData.getAll(name).filter((v): v is string => typeof v === "string" && v !== "");
}

async function bytesOf(formData: FormData, name: string): Promise<Uint8Array | null> {
  const value = formData.get(name);
  if (!(value instanceof File) || value.size === 0) return null;
  // Reject before buffering anything large; the command checks again on the real bytes.
  if (value.size > 2 * 1024 * 1024) return new Uint8Array(2 * 1024 * 1024 + 1);
  return new Uint8Array(await value.arrayBuffer());
}

/** Runs a command and redirects back to `page` with an ok/error message. */
async function run(task: () => Promise<unknown>, page: string, success: string): Promise<never> {
  let message: string;
  try {
    await task();
    redirect(`${page}?ok=${encodeURIComponent(success)}`);
  } catch (error) {
    unstable_rethrow(error); // let Next.js redirects through
    if (!isCommandError(error)) {
      console.error("setup command failed", error);
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

const LIST = "/admin/elections";
const pageOf = (formData: FormData) => `${LIST}/${text(formData, "electionId") ?? ""}`;

// ------------------------------------------------------------------ Elections

export async function createElectionAction(formData: FormData) {
  await run(
    () =>
      executeCommand(createElection, {
        name: text(formData, "name"),
        description: text(formData, "description") ?? "",
        pollingDate: text(formData, "pollingDate"),
        notaEnabled: formData.get("notaEnabled") === "on",
      }),
    LIST,
    "Election created",
  );
}

export async function cloneElectionAction(formData: FormData) {
  await run(
    () =>
      executeCommand(cloneElection, {
        sourceElectionId: text(formData, "sourceElectionId"),
        name: text(formData, "name"),
        pollingDate: text(formData, "pollingDate") ?? undefined,
      }),
    LIST,
    "Election cloned as a new Draft",
  );
}

export async function updateElectionAction(formData: FormData) {
  await run(
    () =>
      executeCommand(updateElection, {
        electionId: text(formData, "electionId"),
        name: text(formData, "name"),
        description: text(formData, "description") ?? "",
        pollingDate: text(formData, "pollingDate"),
        notaEnabled: formData.get("notaEnabled") === "on",
      }),
    pageOf(formData),
    "Election saved",
  );
}

// ---------------------------------------------------------------------- Posts

export async function createPostAction(formData: FormData) {
  await run(
    () =>
      executeCommand(createPost, {
        electionId: text(formData, "electionId"),
        name: text(formData, "name"),
        seats: Number(text(formData, "seats")),
      }),
    pageOf(formData),
    "Post added",
  );
}

export async function updatePostAction(formData: FormData) {
  await run(
    () =>
      executeCommand(updatePost, {
        electionId: text(formData, "electionId"),
        postId: text(formData, "postId"),
        name: text(formData, "name"),
        seats: Number(text(formData, "seats")),
      }),
    pageOf(formData),
    "Post saved",
  );
}

export async function deletePostAction(formData: FormData) {
  await run(
    () =>
      executeCommand(deletePost, {
        electionId: text(formData, "electionId"),
        postId: text(formData, "postId"),
      }),
    pageOf(formData),
    "Post deleted",
  );
}

export async function reorderPostsAction(formData: FormData) {
  await run(
    () =>
      executeCommand(reorderPosts, {
        electionId: text(formData, "electionId"),
        orderedIds: list(formData, "orderedIds"),
      }),
    pageOf(formData),
    "Post order saved",
  );
}

// ----------------------------------------------------------------- Candidates

export async function createCandidateAction(formData: FormData) {
  await run(
    () =>
      executeCommand(createCandidate, {
        electionId: text(formData, "electionId"),
        postId: text(formData, "postId"),
        name: text(formData, "name"),
        symbolText: text(formData, "symbolText"),
      }),
    pageOf(formData),
    "Candidate added",
  );
}

export async function updateCandidateAction(formData: FormData) {
  await run(
    () =>
      executeCommand(updateCandidate, {
        electionId: text(formData, "electionId"),
        candidateId: text(formData, "candidateId"),
        name: text(formData, "name"),
        symbolText: text(formData, "symbolText"),
      }),
    pageOf(formData),
    "Candidate saved",
  );
}

export async function deleteCandidateAction(formData: FormData) {
  await run(
    () =>
      executeCommand(deleteCandidate, {
        electionId: text(formData, "electionId"),
        candidateId: text(formData, "candidateId"),
      }),
    pageOf(formData),
    "Candidate deleted",
  );
}

export async function reorderCandidatesAction(formData: FormData) {
  await run(
    () =>
      executeCommand(reorderCandidates, {
        electionId: text(formData, "electionId"),
        postId: text(formData, "postId"),
        orderedIds: list(formData, "orderedIds"),
      }),
    pageOf(formData),
    "Candidate order saved",
  );
}

export async function setCandidateMediaAction(formData: FormData) {
  await run(
    async () => {
      const { setCandidateMedia } = createMediaCommands(supabaseImageStore());
      await executeCommand(setCandidateMedia, {
        electionId: text(formData, "electionId"),
        candidateId: text(formData, "candidateId"),
        kind: text(formData, "kind"),
        file: await bytesOf(formData, "file"),
      });
    },
    pageOf(formData),
    "Image saved",
  );
}

export async function clearCandidateMediaAction(formData: FormData) {
  await run(
    async () => {
      const { clearCandidateMedia } = createMediaCommands(supabaseImageStore());
      await executeCommand(clearCandidateMedia, {
        electionId: text(formData, "electionId"),
        candidateId: text(formData, "candidateId"),
        kind: text(formData, "kind"),
      });
    },
    pageOf(formData),
    "Image removed",
  );
}

// --------------------------------------------------------------------- Booths

export async function createBoothAction(formData: FormData) {
  await run(
    () =>
      executeCommand(createBooth, {
        electionId: text(formData, "electionId"),
        name: text(formData, "name"),
        location: text(formData, "location"),
      }),
    pageOf(formData),
    "Polling Booth added",
  );
}

export async function updateBoothAction(formData: FormData) {
  await run(
    () =>
      executeCommand(updateBooth, {
        electionId: text(formData, "electionId"),
        boothId: text(formData, "boothId"),
        name: text(formData, "name"),
        location: text(formData, "location"),
      }),
    pageOf(formData),
    "Polling Booth saved",
  );
}

export async function deleteBoothAction(formData: FormData) {
  await run(
    () =>
      executeCommand(deleteBooth, {
        electionId: text(formData, "electionId"),
        boothId: text(formData, "boothId"),
      }),
    pageOf(formData),
    "Polling Booth deleted",
  );
}

export async function setBoothPostsAction(formData: FormData) {
  await run(
    () =>
      executeCommand(setBoothPosts, {
        electionId: text(formData, "electionId"),
        boothId: text(formData, "boothId"),
        postIds: list(formData, "postIds"),
      }),
    pageOf(formData),
    "Booth-Post mapping saved",
  );
}

// ------------------------------------------------------------- Freeze/unfreeze

export async function freezeAction(formData: FormData) {
  await run(
    () => executeCommand(freezeSetup, { electionId: text(formData, "electionId") }),
    pageOf(formData),
    "Setup frozen",
  );
}

export async function unfreezeAction(formData: FormData) {
  await run(
    () => executeCommand(unfreezeSetup, { electionId: text(formData, "electionId") }),
    pageOf(formData),
    "Setup returned to Draft",
  );
}
