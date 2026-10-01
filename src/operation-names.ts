// Shared catalog projections; context guidance and MCP must name identical actions.
export const campaignReadOperations = new Set([
  "status",
  "preview",
  "placement-status",
  "placement-preview",
]);
export const splitCampaignOperations = new Set([
  "post",
  "client_email",
  "client_linkedin",
]);
export function operationToolNames(resource: string, action: string): string[] {
  const base =
    resource === "summary" && action === "next_step"
      ? "next_step"
      : `${resource.replace(/-/g, "_")}_${action}`;
  return resource === "campaigns" && splitCampaignOperations.has(action)
    ? [`${base}_read`, `${base}_write`]
    : [base];
}
