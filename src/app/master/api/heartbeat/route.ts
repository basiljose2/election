import { terminalEndpoints } from "@/lib/terminals/http";

export const POST = terminalEndpoints("master").heartbeat;
