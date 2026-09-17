import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
import { WorkspaceCampaignRequest, workspaceCampaignResultFor, type WorkspaceCampaignInput, type WorkspaceCampaignOutput } from "./workspace-campaign-contracts.js";

export function createWorkspaceCampaignOperations(serverKey: string) {
  if (serverKey.length < 32) throw new Error("Invalid outreach server capability.");
  return async (session: AuthSession, input: WorkspaceCampaignInput): Promise<WorkspaceCampaignOutput> => {
    const parsed = WorkspaceCampaignRequest.parse(input);
    const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
    const unavailable = () => new PublicError({ status: 502, code: "WORKSPACE_CAMPAIGN_UNAVAILABLE", message: "The workspace sequence could not be verified. Retain its reference and read its status before retrying." });
    let response;
    try { response = await client.rpc("lifty_workspace_outreach", { p_server_key: serverKey, p_operation: parsed.operation, p_payload: parsed.payload }); }
    catch { throw unavailable(); }
    if (response.error) {
      const error = response.error as { code?: string; message?: string };
      const messages: Record<string, string> = {
        outreach_workspace_forbidden: "The workspace is not accessible.", outreach_approval_stale: "The workspace configuration changed. Read its preview before confirming activation.",
        outreach_prerequisites_missing: "The workspace sequence has unresolved blockers. Read its current preview.",
        outreach_invalid_configuration: "Use the current campaign configuration schema and complete both configured sequences.",
      };
      if (error.message && messages[error.message] && ["PT400", "PT403", "PT409"].includes(error.code ?? "")) throw new PublicError({ status: Number(error.code!.slice(2)) as 400 | 403 | 409, code: error.message.toUpperCase(), message: messages[error.message]! });
      throw unavailable();
    }
    try { return workspaceCampaignResultFor(parsed, response.data); } catch { throw unavailable(); }
  };
}
