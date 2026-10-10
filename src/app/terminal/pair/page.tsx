import type { Metadata } from "next";
import { PageShell } from "@/components/ui";
import { PairForm } from "./pair-form";

export const metadata: Metadata = { title: "Pair this device · Campus EVM" };

export default async function PairPage({ searchParams }: PageProps<"/terminal/pair">) {
  const params = await searchParams;
  const code = typeof params.code === "string" && /^\d{6}$/.test(params.code) ? params.code : "";
  const booth =
    typeof params.booth === "string" && /^[0-9a-f-]{36}$/i.test(params.booth) ? params.booth : "";
  return (
    <PageShell title="Pair this device as a Voting Terminal">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Enter the 6-digit code shown on the booth&apos;s Master Terminal. The Presiding Officer will
        then confirm the device id shown here.
      </p>
      <PairForm initialCode={code} booth={booth} />
    </PageShell>
  );
}
