import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db/pool";
import { TERMINAL_COOKIES, verifyTerminalCredential } from "@/lib/terminals/credentials";
import { VotingTerminalScreen } from "./terminal-screen";

export const metadata: Metadata = { title: "Voting Terminal · Campus EVM" };

export default async function VotingTerminalPage() {
  const token = (await cookies()).get(TERMINAL_COOKIES.voting.name)?.value;
  const check = await verifyTerminalCredential(getPool(), token, { type: "voting" });
  if (!check.ok) redirect("/terminal/pair");
  return <VotingTerminalScreen />;
}
