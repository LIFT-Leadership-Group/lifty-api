import type { AppDependencies, AuthSession } from "./app.js";
import {
  AttioConnectionStatusSchema,
  HubspotConnectionStatusSchema,
  type CrmConnectionStatus,
} from "./contracts.js";

/** The workspace has at most one connected CRM; HubSpot and Attio are never both active. */
export async function readCrmConnection(
  deps: Pick<AppDependencies, "getHubspotConnection" | "getAttioConnection">,
  session: AuthSession,
): Promise<CrmConnectionStatus> {
  const [hubspot, attio] = await Promise.all([
    deps.getHubspotConnection(session).then(value => HubspotConnectionStatusSchema.parse(value)),
    deps.getAttioConnection(session).then(value => AttioConnectionStatusSchema.parse(value)),
  ]);
  if (attio.status === "connected") return attio;
  if (hubspot.status === "connected") return hubspot;
  return { provider: null, status: "not_connected" };
}

export function crmAccountLabel(connection: CrmConnectionStatus): string | null {
  if (connection.status !== "connected") return null;
  return connection.provider === "hubspot" ? `HubSpot portal ${connection.portal_id}` : `Attio workspace ${connection.workspace_name}`;
}
