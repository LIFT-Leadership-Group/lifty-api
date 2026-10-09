export const notificationPatchToolNames = {
  destination: "notifications_destination_upsert",
  route: "notifications_route_set",
} as const;

// Compound HTTP/CLI operations can expose separate, fixed MCP capabilities.
export function operationToolNames(resource: string, action: string): string[] {
  if (resource === "notifications" && action === "patch") return Object.values(notificationPatchToolNames);
  return [resource === "summary" && action === "next_step" ? "next_step" : `${resource.replace(/-/g, "_")}_${action}`];
}
