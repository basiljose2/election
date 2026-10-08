"use client";

// Deliberately broken: a Client Component importing the server-only env module.
// tests/integration/client-import.test.ts asserts that `next build` rejects this.
import { serverEnv } from "../../../../src/lib/env/server";

export default function Page() {
  return <p>{typeof serverEnv}</p>;
}
