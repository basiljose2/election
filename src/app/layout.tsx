import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Campus EVM",
  description: "Campus election system",
  referrer: "no-referrer",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page is rendered per request so Next.js can apply the CSP nonce set by the proxy.
  await connection();
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
