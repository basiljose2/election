import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { appendAuditEvent } from "@/lib/audit/append";
import { getPool } from "@/lib/db/pool";
import type { Actor } from "./roles";
import {
  actorForCommand,
  resolveActor,
  type ActorResolution,
  type VerifiedClaims,
} from "./resolve-actor";
import { createSupabaseServerClient } from "./supabase";

/** Resolves the current request's actor once per request. */
export const getActorResolution = cache(async (): Promise<ActorResolution> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.session_id) return { status: "unauthenticated" };
  return resolveActor(data.claims as VerifiedClaims, {
    db: getPool(),
    now: () => new Date(),
    appendAudit: appendAuditEvent,
  });
});

/** For commands: a fully authenticated actor (MFA complete where required) or an error. */
export async function requireActorForCommand(): Promise<Actor> {
  return actorForCommand(await getActorResolution());
}

/** For pages: a fully authenticated actor, or a redirect to the right auth step. */
export async function requireActorForPage(): Promise<Actor> {
  const resolution = await getActorResolution();
  switch (resolution.status) {
    case "ok":
      return resolution.actor;
    case "mfa_required":
      redirect("/mfa");
    case "idle_timeout":
      redirect("/sign-in?reason=idle");
    case "inactive":
    case "session_ended":
    case "unauthenticated":
      redirect("/sign-in");
  }
}
