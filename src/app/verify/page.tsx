import type { Metadata } from "next";
import { PageShell } from "@/components/ui";
import { VerifierClient } from "./verifier-client";

export const metadata: Metadata = { title: "Verify an election · Campus EVM" };

export default function VerifyPage() {
  return (
    <PageShell title="Verify an election">
      <p className="text-sm">
        Choose the verification bundle (the zip downloaded from an election&apos;s public page). The
        checks run in your browser, on your computer: the file is never uploaded and this page makes
        no network requests while it verifies. They recompute every hash and signature, every
        booth&apos;s Merkle root, a full recount and the winner rules.
      </p>
      <VerifierClient />
    </PageShell>
  );
}
