"use server";

import QRCode from "qrcode";
import { cookies, headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { isCommandError } from "@/lib/commands/errors";
import { executeCommand } from "@/lib/commands/gateway";
import { createTerminalCommands } from "@/lib/commands/terminals";
import { getSignalPublisher } from "@/lib/signals/server";
import { TERMINAL_COOKIES, terminalCookieOptions } from "@/lib/terminals/credentials";

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
