import { z } from "@hono/zod-openapi";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

export const ApolloCredentialChoice = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("status") }).strict(),
  z.object({ operation: z.literal("platform_default") }).strict(),
  z.object({ operation: z.literal("own_key"), api_key: z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/).openapi({writeOnly:true,format:"password"}) }).strict(),
]);
export const ApolloCredentialResult = z.object({
  workspace_ref: z.uuid(), tool: z.literal("apollo"),
  key_source: z.enum(["platform_default", "own_key"]).nullable(),
  configured: z.boolean(), changed: z.boolean(),
}).strict();
export type ApolloCredentialInput = z.infer<typeof ApolloCredentialChoice>;
export type ApolloCredentialOutput = z.infer<typeof ApolloCredentialResult>;
const messages: Record<string, string> = {
  unauthenticated: "Sign in to LIFTY before configuring Apollo.",
  workspace_forbidden: "Choose a workspace you belong to.",
  workspace_not_lifty: "This operation requires a workspace created by LIFTY.",
  workspace_suspended: "Resume this workspace before changing its Apollo credential.",
  apollo_invalid_request: "Choose platform_default or provide your own Apollo key.",
  apollo_execution_in_progress: "Apollo work is still in progress. Finish or resume it before changing credentials.",
  apollo_platform_unavailable: "The shared Apollo credential is not configured. Contact LIFT support.",
  apollo_platform_key_requires_default: "Use the platform_default option for the shared Apollo credential.",
};
function failed(error: unknown): never {
  const parsed = z.object({code:z.string().optional(),message:z.string().optional()}).safeParse(error);
  const code = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(messages, code);
  const status = known && parsed.success && /^PT(400|401|403|409)$/.test(parsed.data.code ?? "") ? Number(parsed.data.code!.slice(2)) : 502;
  throw new PublicError({status,code:known ? code.toUpperCase() : "APOLLO_CREDENTIAL_UNAVAILABLE",message:known ? messages[code]! : "LIFTY could not complete the Apollo credential request. Retry the same choice shortly."});
}
export async function apolloCredentials(session: AuthSession, workspace: string, input: ApolloCredentialInput): Promise<ApolloCredentialOutput> {
  const workspaceId = z.uuid().parse(workspace);
  const choice = ApolloCredentialChoice.parse(input);
  const client = session.client as {rpc(name:string,args:Record<string,unknown>):Promise<{data:unknown;error:unknown}>};
  let result;
  try { result = await client.rpc("lifty_apollo_credentials", {p_workspace_id:workspaceId,p_operation:choice.operation,p_api_key:choice.operation === "own_key" ? choice.api_key : null}); }
  catch { failed(null); }
  if (result.error) failed(result.error);
  const parsed = ApolloCredentialResult.safeParse(result.data);
  if (!parsed.success || parsed.data.workspace_ref !== workspaceId || (choice.operation !== "status" && (!parsed.data.configured || parsed.data.key_source !== choice.operation))) failed(null);
  return parsed.data;
}
