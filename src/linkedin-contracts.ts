import { z } from "zod";

export const LinkedinWorkspace = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);
export const LinkedinTimezone = z.string().min(1).max(100).refine(value => {
  // Reject fixed-offset strings; SQL validates against pg_timezone_names too.
  if (!/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Choose a valid IANA timezone.");
export const LinkedinHealthStatus = z.enum(["running", "credentials", "locked", "disconnected", "errored", "unknown", "connecting", "stopped", "deleted"]);
export const LinkedinProfileId = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
export const LinkedinProfileUrl = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && ["linkedin.com", "www.linkedin.com"].includes(url.hostname)
    && !url.username && !url.password && !url.port && !url.search && !url.hash && /^\/in\/[^/]+\/?$/.test(url.pathname);
});
export const LinkedinPolicy = z.object({
  invitations_per_day: z.literal(5), invitations_per_7_days: z.literal(25), messages_per_day: z.literal(5),
  weekdays: z.array(z.number().int().min(1).max(5)).length(5).refine(value => value.join(",") === "1,2,3,4,5"),
  start: z.literal("09:00"), end: z.literal("17:00"),
  spacing_minutes: z.array(z.number().int()).length(2).refine(value => value.join(",") === "15,45"),
}).strict();
export const LINKEDIN_POLICY = LinkedinPolicy.parse({ invitations_per_day: 5, invitations_per_7_days: 25, messages_per_day: 5, weekdays: [1, 2, 3, 4, 5], start: "09:00", end: "17:00", spacing_minutes: [15, 45] });
export const LinkedinConnectRequest = z.object({
  workspace: LinkedinWorkspace, timezone: LinkedinTimezone,
  account_use: z.literal("personal"), other_automation: z.literal(false),
}).strict();
export const LinkedinWorkspaceRequest = z.object({ workspace: LinkedinWorkspace }).strict();
export const LinkedinDisconnectRequest = LinkedinWorkspaceRequest.extend({ confirm: z.literal(true) }).strict();
export const LinkedinFailureCode = z.enum(["identity_mismatch", "provider_unavailable", "link_failed"]);
const profile = {
  provider: z.literal("unipile"), channel: z.literal("linkedin"), workspace_ref: z.uuid(),
  profile_id: LinkedinProfileId.nullable(), profile_url: LinkedinProfileUrl.nullable(), display_name: z.string().max(401).nullable(),
  timezone: LinkedinTimezone, account_use: z.literal("personal"), other_automation: z.literal(false),
  policy: LinkedinPolicy, health_status: LinkedinHealthStatus, sending_enabled: z.boolean(),
};
export const LinkedinConnectionStatus = z.discriminatedUnion("status", [
  z.object({ provider: z.literal("unipile"), channel: z.literal("linkedin"), workspace_ref: z.uuid(), status: z.literal("not_connected") }).strict(),
  z.object({ ...profile, status: z.enum(["pending", "connected", "disconnected", "failed"]),
    connection_ref: z.uuid().nullable(), intent_ref: z.uuid().nullable(), failure_code: LinkedinFailureCode.nullable(),
  }).strict(),
]).superRefine((value, ctx) => {
  if (value.status === "not_connected") return;
  if ((value.sending_enabled && value.status !== "connected")
    || (value.status === "connected" && (!value.profile_id || !value.connection_ref || value.health_status !== "running")))
    ctx.addIssue({ code: "custom", message: "LinkedIn connection health and outbound state are inconsistent." });
});
export const LinkedinConnectResult = z.discriminatedUnion("status", [
  z.object({ ...profile, status: z.literal("pending"), sending_enabled: z.literal(false), connect_url: z.url(), intent_ref: z.uuid(), expires_in_seconds: z.number().int().min(1).max(1800) }).strict(),
  z.object({ ...profile, status: z.literal("connected"), profile_id: LinkedinProfileId, connection_ref: z.uuid(), health_status: z.literal("running") }).strict(),
]);
export type LinkedinConnectInput = z.infer<typeof LinkedinConnectRequest>;
export type LinkedinStart = z.infer<typeof LinkedinConnectResult>;
export type LinkedinStatus = z.infer<typeof LinkedinConnectionStatus>;
