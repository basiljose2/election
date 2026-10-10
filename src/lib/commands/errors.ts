export type CommandErrorCode =
  | "unauthenticated"
  | "mfa_required"
  | "forbidden"
  | "reauth_required"
  | "invalid_input"
  | "lifecycle"
  | "invalid_transition"
  | "conflict"
  | "not_found";

/** Errors whose message is safe to show to the caller. */
export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export const isCommandError = (e: unknown): e is CommandError => e instanceof CommandError;
