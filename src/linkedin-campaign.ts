import type { AuthSession } from "./app.js";
import { LinkedinCampaignRequest, linkedinCampaignResultFor, type LinkedinCampaignInput, type LinkedinCampaignOutput } from "./linkedin-campaign-contracts.js";
import { linkedinFailure, mapLinkedinRpcError } from "./linkedin-errors.js";

export function createLinkedinCampaignOperations(serverKey: string) {
  if (serverKey.length < 32) throw new Error("Invalid LinkedIn server key.");
  return async (session: AuthSession, input: LinkedinCampaignInput): Promise<LinkedinCampaignOutput> => {
    const parsed = LinkedinCampaignRequest.parse(input);
    const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
    let response;
    try {
      // Caller JWT + dedicated capability. This API has no unrestricted table access.
      response = await client.rpc("lifty_linkedin_campaign", { p_server_key: serverKey, p_operation: parsed.operation, p_payload: parsed.payload });
    } catch (error) { mapLinkedinRpcError(error, "LINKEDIN_CAMPAIGN_UNAVAILABLE"); }
    if (response.error) mapLinkedinRpcError(response.error, "LINKEDIN_CAMPAIGN_UNAVAILABLE");
    try { return linkedinCampaignResultFor(parsed, response.data); }
    catch { linkedinFailure("LINKEDIN_CAMPAIGN_UNAVAILABLE"); }
  };
}
