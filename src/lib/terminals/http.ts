import "server-only";
import { cookies } from "next/headers";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import { mintChannelAccess } from "@/lib/signals/server";
import { TERMINAL_COOKIES, type AuthenticatedTerminal, type TerminalType } from "./credentials";
import { guardTerminal } from "./guard";
import { getTerminalState, recordHeartbeat } from "./state";

const json = (status: number, body: object) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Endpoints shared by both terminal types. They authenticate with the device credential only
 * (cookie scoped to /master or /terminal), never with a staff session, and check the terminal
 * type for the route they are mounted on.
 */
export function terminalEndpoints(type: TerminalType) {
  const base = `/${type === "master" ? "master" : "terminal"}/api`;
  const deps = () => ({ db: getPool(), appendAudit: appendAuditEvent });

  async function authenticate(
    route: string,
  ): Promise<{ terminal: AuthenticatedTerminal } | { response: Response }> {
    const presented = (await cookies()).get(TERMINAL_COOKIES[type].name)?.value;
    const result = await guardTerminal(deps(), presented, { type }, `${base}/${route}`);
    if (!result.ok) return { response: json(result.status, { error: result.error }) };
    return { terminal: result.terminal };
  }

  return {
    /** Authoritative state; clients call it on load, on every signal and on reconnect. */
    async state() {
      const auth = await authenticate("state");
      if ("response" in auth) return auth.response;
      const state = await getTerminalState({ ...deps(), now: () => new Date() }, auth.terminal);
      return json(200, state);
    },

    async heartbeat() {
      const auth = await authenticate("heartbeat");
      if ("response" in auth) return auth.response;
      await recordHeartbeat(getPool(), auth.terminal.id, new Date());
      return json(200, { ok: true });
    },

    /** A short-lived credential for this terminal's booth channel only. */
    async channelToken() {
      const auth = await authenticate("channel-token");
      if ("response" in auth) return auth.response;
      return json(200, await mintChannelAccess(auth.terminal, new Date()));
    },
  };
}
