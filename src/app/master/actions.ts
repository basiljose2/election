"use server";

import QRCode from "qrcode";
import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { getActorResolution, requireActorForCommand } from "@/lib/auth/current-actor";
import { signInForRequest } from "@/lib/auth/password-signin";
import { boothGrant, isPrivileged } from "@/lib/auth/roles";
import { createBallotCommands } from "@/lib/commands/ballots";
import { CANCEL_REASONS, type CancelReason } from "@/lib/commands/cancel-reasons";
import { CommandError, isCommandError } from "@/lib/commands/errors";
import { executeCommand } from "@/lib/commands/gateway";
import { createTerminalCommands } from "@/lib/commands/terminals";
import { getPool } from "@/lib/db/pool";
import { createAppLifecycle } from "@/lib/lifecycle/app";
import { getSignalPublisher } from "@/lib/signals/server";
import {
  TERMINAL_COOKIES,
  terminalCookieOptions,
  verifyTerminalCredential,
} from "@/lib/terminals/credentials";

async function commands() {
  return createTerminalCommands(await getSignalPublisher());
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function messageFor(error: unknown): string {
  if (isCommandError(error)) {
    if (error.code === "unauthenticated" || error.code === "mfa_required") redirect("/sign-in");
    return error.message;
  }
  console.error("master action failed", error);
  return "Something went wrong. Nothing was changed.";
}

export async function registerMasterAction(formData: FormData) {
  let failure: string | null = null;
  try {
    const { token } = await executeCommand((await commands()).registerMaster, {
      boothId: field(formData, "boothId"),
    });
    (await cookies()).set(
      TERMINAL_COOKIES.master.name,
      token,
      terminalCookieOptions(TERMINAL_COOKIES.master.path),
    );
  } catch (error) {
    unstable_rethrow(error);
    failure = messageFor(error);
  }
  redirect(failure ? `/master?error=${encodeURIComponent(failure)}` : "/master");
}

export type CodeResult =
  | { ok: true; code: string; expiresAt: string; qrSvg: string }
  | { ok: false; error: string }
  | null;

/** Generates a one-time code; returns it (and its QR code) to the Master Terminal screen only. */
export async function generateCodeAction(
  _previous: CodeResult,
  formData: FormData,
): Promise<CodeResult> {
  try {
    const boothId = field(formData, "boothId");
    const masterToken = (await cookies()).get(TERMINAL_COOKIES.master.name)?.value ?? "";
    const { code, expiresAt } = await executeCommand((await commands()).generatePairingCode, {
      boothId,
      masterToken,
    });
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
    const url = `${proto}://${host}/terminal/pair?code=${code}&booth=${boothId}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, width: 192 });
    return { ok: true, code, expiresAt: expiresAt.toISOString(), qrSvg };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: messageFor(error) };
  }
}

async function decide(kind: "confirmPairing" | "rejectPairing", formData: FormData): Promise<void> {
  let failure: string | null = null;
  try {
    const masterToken = (await cookies()).get(TERMINAL_COOKIES.master.name)?.value ?? "";
    await executeCommand((await commands())[kind], {
      boothId: field(formData, "boothId"),
      masterToken,
      codeId: field(formData, "codeId"),
      deviceId: field(formData, "deviceId"),
    });
  } catch (error) {
    unstable_rethrow(error);
    failure = messageFor(error);
  }
  redirect(failure ? `/master?error=${encodeURIComponent(failure)}` : "/master");
}

export async function confirmPairingAction(formData: FormData) {
  await decide("confirmPairing", formData);
}

export async function rejectPairingAction(formData: FormData) {
  await decide("rejectPairing", formData);
}

// ---- Ballot, mock poll, open and close -------------------------------------------------------

export type ActionResult = { ok: true } | { ok: false; error: string };

async function masterToken(): Promise<string> {
  return (await cookies()).get(TERMINAL_COOKIES.master.name)?.value ?? "";
}

/** Runs one Master Terminal action and turns any refusal into a message for the screen. */
async function run(work: () => Promise<void>): Promise<ActionResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    return { ok: false, error: messageFor(error) };
  }
}

/** "Ballot": enables exactly one ballot on the booth's Voting Terminal. */
export async function issueBallotAction(boothId: string): Promise<ActionResult> {
  return run(async () => {
    const commandSet = createBallotCommands(await getSignalPublisher());
    await executeCommand(commandSet.issueBallotSession, {
      boothId,
      masterToken: await masterToken(),
    });
  });
}

export async function cancelBallotAction(
  boothId: string,
  reason: string,
  note?: string,
): Promise<ActionResult> {
  return run(async () => {
    if (!(CANCEL_REASONS as readonly string[]).includes(reason)) {
      throw new CommandError("invalid_input", "Choose a reason for cancelling the ballot");
    }
    const commandSet = createBallotCommands(await getSignalPublisher());
    await executeCommand(commandSet.cancelBallotSession, {
      boothId,
      masterToken: await masterToken(),
      reason: reason as CancelReason,
      note,
    });
  });
}

export type BoothTransition =
  "start_mock_poll" | "clear_mock_poll" | "repeat_mock_poll" | "open_poll" | "close_poll";

const TRANSITION_COMMAND = {
  start_mock_poll: "startMockPoll",
  clear_mock_poll: "clearMockPoll",
  repeat_mock_poll: "repeatMockPoll",
  open_poll: "openPoll",
  close_poll: "closePoll",
} as const satisfies Record<BoothTransition, string>;

/**
 * A booth transition on behalf of the Presiding Officer. Only the booth's registered Master
 * Terminal may send it; the lifecycle engine then checks role, re-authentication, state and
 * guards. Closing also needs the typed word CLOSE.
 */
export async function boothTransitionAction(
  boothId: string,
  action: BoothTransition,
  confirmation?: string,
): Promise<ActionResult> {
  return run(async () => {
    const command = TRANSITION_COMMAND[action];
    if (!command) throw new CommandError("invalid_input", "Unknown action");
    if (action === "close_poll" && confirmation !== "CLOSE") {
      throw new CommandError("invalid_input", "Type CLOSE to confirm closing the poll");
    }
    const actor = await requireActorForCommand();
    const grant = boothGrant(actor, boothId);
    if (!grant?.electionId) {
      throw new CommandError("forbidden", "You are not authorized to perform this action");
    }
    const device = await verifyTerminalCredential(getPool(), await masterToken(), {
      type: "master",
      boothId,
    });
    if (!device.ok) {
      throw new CommandError(
        "forbidden",
        "This device is not the registered Master Terminal of the booth",
      );
    }
    const lifecycle = createAppLifecycle(await getSignalPublisher());
    await executeCommand(lifecycle[command], { electionId: grant.electionId, boothId });
  });
}

/**
 * Re-authentication from the Master Terminal screen (open, close and unlock): the Presiding
 * Officer's password goes through the same rate-limited sign-in as /reauth, which replaces the
 * session with a fresh one. The critical command that follows is then checked by the gateway
 * against that fresh authentication time.
 */
export async function reauthenticateMasterAction(password: string): Promise<ActionResult> {
  const resolution = await getActorResolution();
  if (resolution.status !== "ok") redirect("/sign-in");
  const { actor } = resolution;
  // Roles that also need a TOTP code use the full page.
  if (isPrivileged(actor)) redirect("/reauth?next=/master");

  const result = await signInForRequest(actor.email, password, actor.sessionId);
  if (result.status === "locked") {
    return { ok: false, error: "Too many failed attempts. Try again in 15 minutes." };
  }
  if (result.status !== "ok") return { ok: false, error: "Incorrect password." };
  return { ok: true };
}
