import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { rpcFailure } from "./rpc-errors.js";
import type { IdentityDefinition, IdentityInput } from "./identity-operations.js";
import { LinkedinActivitySchema, LinkedinQuerySchema } from "./linkedin-contracts.js";

// LIF-1190 LinkedIn: one read of confirmed activity and waiting reasons per
// LinkedIn account. Campaigns own sequences and their lifecycle; Identity owns
// accounts and connecting. Like Identity, the database resolves the workspace
// from the session's x-lifty-workspace header (p_workspace_id null).
const Empty = z.object({}).strict();
export type LinkedinInput = IdentityInput;
const unavailable = {
  code: "LINKEDIN_STATUS_UNAVAILABLE",
  message: "LinkedIn activity could not be verified. Read it again; a failed read is not zero activity.",
};
export const linkedinOperationDefinitions = {
  linkedin: {
    get: {
      method: "GET", route: "/v1/workspace/linkedin", rpc: "get_lifty_linkedin", path: Empty,
      query: LinkedinQuerySchema, request: null, invalid: { status: 400, code: "INVALID_REQUEST" },
      response: LinkedinActivitySchema, success: 200, args: input => ({ p_query: input.query }),
      description: "Read LinkedIn activity today (since 00:00 UTC) and over the last 7 days, the same periods as the Senders page: invitations sent and accepted, messages sent and replies received, as confirmed events (not people), for the workspace and each LinkedIn account. With sender_id, totals and accounts cover only that sender's account; a sender without a LinkedIn account has no accounts and true zero counts. Each account also shows its connection status, usage state and why its due work waits. Read-only; never contacts LinkedIn or changes work.",
    },
  },
} satisfies Record<string, Record<string, IdentityDefinition>>;
export const linkedinEntries = () => Object.entries(linkedinOperationDefinitions).flatMap(([resource, operations]) =>
  Object.entries(operations).map(([action, definition]) => ({ key: `${resource}.${action}`, definition: definition as IdentityDefinition })));

export async function executeLinkedinOperation(session: AuthSession, key: string, input: LinkedinInput): Promise<unknown> {
  const entry = linkedinEntries().find(item => item.key === key);
  if (!entry) throw new Error("Unknown LinkedIn operation");
  const { definition } = entry;
  let result: { data: unknown; error: unknown };
  try { result = await (session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> })
    .rpc(definition.rpc, { p_workspace_id: null, ...definition.args(input) }); }
  catch (cause) { throw rpcFailure(cause, { operation: definition.rpc, ...unavailable }); }
  if (result.error) throw rpcFailure(result.error, { operation: definition.rpc, ...unavailable });
  const parsed = definition.response.safeParse(result.data);
  // A read for one sender cannot be confirmed by another sender's accounts.
  const sender = (input.query as { sender_id?: string }).sender_id;
  if (!parsed.success || (sender && (parsed.data as z.infer<typeof LinkedinActivitySchema>).accounts.some(account => account.sender_id !== sender)))
    throw new PublicError({ status: 502, ...unavailable });
  return parsed.data;
}
