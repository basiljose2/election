import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Button, Notice, PageShell } from "@/components/ui";
import { requireActorForPage } from "@/lib/auth/current-actor";
import { getPool } from "@/lib/db/pool";
import { TERMINAL_COOKIES, verifyTerminalCredential } from "@/lib/terminals/credentials";
import { registerMasterAction } from "./actions";
import { MasterPanel } from "./master-panel";

export const metadata: Metadata = { title: "Master Terminal · Campus EVM" };

export default async function MasterPage({ searchParams }: PageProps<"/master">) {
  const actor = await requireActorForPage();
  const po = actor.roles.find((r) => r.role === "presiding_officer" && r.boothId);
  if (!po?.boothId) {
    return (
      <PageShell title="Master Terminal">
        <Notice tone="error">
          Only a Presiding Officer assigned to a booth can use this screen.
        </Notice>
      </PageShell>
    );
  }
  const params = await searchParams;
  const error = typeof params.error === "string" ? params.error : null;

  const token = (await cookies()).get(TERMINAL_COOKIES.master.name)?.value;
  const check = await verifyTerminalCredential(getPool(), token, {
    type: "master",
    boothId: po.boothId,
  });

  if (!check.ok && check.reason === "booth_closed") {
    return (
      <PageShell title="Master Terminal">
        <Notice tone="info">The poll at this booth is closed.</Notice>
      </PageShell>
    );
  }
  if (!check.ok) {
    return (
      <PageShell title="Register this device">
        {error && <Notice tone="error">{error}</Notice>}
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This device is not the Master Terminal of your booth. Registering it makes it the only
          device that can control the booth, and revokes any earlier Master Terminal.
        </p>
        <form action={registerMasterAction}>
          <input type="hidden" name="boothId" value={po.boothId} />
          <Button type="submit">Register this device as the Master Terminal</Button>
        </form>
      </PageShell>
    );
  }
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6">
      <h1 className="sr-only">Master Terminal</h1>
      {error && <Notice tone="error">{error}</Notice>}
      <MasterPanel boothId={po.boothId} />
    </main>
  );
}
