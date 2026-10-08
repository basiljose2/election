import { describe, expect, it } from "vitest";
import { parseServerEnv, resolveAppEnv } from "./server";

const base = {
  DATABASE_URL: "postgresql://app_server:pw@127.0.0.1:54322/postgres",
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_PUBLISHABLE_KEY: "pk",
  SUPABASE_SECRET_KEY: "sk",
};

describe("server env", () => {
  it("maps VERCEL_ENV to the app environment", () => {
    expect(resolveAppEnv(undefined)).toBe("local");
    expect(resolveAppEnv("development")).toBe("local");
    expect(resolveAppEnv("preview")).toBe("preview");
    expect(resolveAppEnv("production")).toBe("production");
  });

  it("accepts a valid local environment", () => {
    expect(parseServerEnv(base).appEnv).toBe("local");
  });

  it("reports missing variables by name only", () => {
    expect(() => parseServerEnv({ ...base, SUPABASE_SECRET_KEY: undefined })).toThrow(
      "Invalid server environment: SUPABASE_SECRET_KEY",
    );
  });

  it("rejects a database connection that is not app_server", () => {
    expect(() =>
      parseServerEnv({ ...base, DATABASE_URL: "postgresql://postgres:pw@127.0.0.1/postgres" }),
    ).toThrow("app_server");
  });

  it("accepts the pooler form of the app_server user", () => {
    const env = parseServerEnv({
      ...base,
      VERCEL_ENV: "preview",
      DATABASE_URL: "postgresql://app_server.abcd:pw@aws-0.pooler.supabase.com:6543/postgres",
      SUPABASE_URL: "https://abcd.supabase.co",
    });
    expect(env.appEnv).toBe("preview");
  });

  it("rejects local hosts outside local development", () => {
    expect(() => parseServerEnv({ ...base, VERCEL_ENV: "production" })).toThrow(
      "local host in the production environment",
    );
  });
});
