import { z } from "zod";
import type { AppDependencies, AuthSession } from "./app.js";
import { BusinessWebsiteSchema } from "./business-website.js";
import { WorkspaceConfigSchema, WorkspaceStatusSchema } from "./contracts.js";
import { EmailConnectionStatus } from "./email-contracts.js";
import { LinkedinConnectionStatus } from "./linkedin-contracts.js";
import { WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { PublicError } from "./errors.js";

export const readResult = <T extends z.ZodType>(schema: T) => z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), value: schema }).strict(),
  z.object({ status: z.literal("unavailable"), next_action: z.literal("retry_read") }).strict(),
]);
export type ReadResult<T> = { status: "available"; value: T } | { status: "unavailable"; next_action: "retry_read" };
const WORKSPACE_SCOPE_CONFLICTS = new Set([
  "WORKSPACE_CHANGED",
  "WORKSPACE_UNAVAILABLE",
  "WORKSPACE_MISSING",
  "WORKSPACE_AMBIGUOUS",
  "WORKSPACE_SUSPENDED",
]);
// Never convert an authentication/scope failure into an incomplete success.
export async function readComponent<T>(read: () => Promise<T>): Promise<ReadResult<T>> {
  try { return { status: "available", value: await read() }; } catch (error) {
    if (error instanceof PublicError && ([401, 403].includes(error.status) || WORKSPACE_SCOPE_CONFLICTS.has(error.code))) throw error;
    return { status: "unavailable", next_action: "retry_read" };
  }
}
function scoped<T extends { workspace_ref: string }>(value: T, current: string): T {
  if (value.workspace_ref !== current) throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Workspace state changed. Read the current workspace again." });
  return value;
}
const Account = z.object({ connection_status: z.enum(["not_connected", "pending", "connected", "disconnected", "failed"]),
  identity: z.string().nullable(), sending_enabled: z.boolean().nullable(), failure_code: z.string().nullable() }).strict();
const Campaign = z.object({
  state: WorkspaceCampaignResult.shape.state, outreach_enabled: z.boolean(), version_ref: z.uuid().nullable(),
  selected_channels: z.array(z.enum(["email", "linkedin"])), templates: z.object({ email: z.number().int(), linkedin: z.number().int() }).strict(),
  engine: z.enum(["fixed_v1", "shared_v1"]).nullable(),
  compose_modes: z.object({ email: z.enum(["generate", "templates"]).nullable(), linkedin: z.enum(["generate", "templates"]).nullable() }).strict().nullable(),
  preparation: WorkspaceCampaignResult.shape.preparation.nullable(),
  eligible_count: z.number().int(), includes_future_leads: z.boolean().nullable(),
  audience: z.enum(["qualified_ab", "explicit_leads"]).nullable(),
  progress: WorkspaceCampaignResult.shape.progress, blockers: WorkspaceCampaignResult.shape.blockers,
  continuing_version_count: z.number().int(),
}).strict();
export const WorkspaceSummarySchema = z.object({
  observed_at: z.iso.datetime(), workspace: WorkspaceStatusSchema,
  business: readResult(z.object({ name: z.string(), description: z.string().nullable() }).strict()).nullable(),
  website: readResult(BusinessWebsiteSchema).nullable(),
  setup: readResult(z.object({ targeting_saved: z.boolean(), research_saved: z.boolean(), voice_saved: z.boolean() }).strict()).nullable(),
  email: readResult(Account).nullable(), linkedin: readResult(Account).nullable(),
  campaign: readResult(Campaign).nullable(),
  detail_operations: z.object({ business: z.literal("business.get"), email: z.literal("sending-accounts.get channel=email"),
    linkedin: z.literal("sending-accounts.get channel=linkedin"), campaign: z.literal("campaigns.get"),
    targeting: z.literal("targeting.get"), voice: z.literal("commercial-voice.get") }).strict(),
}).strict();
export async function getWorkspaceSummary(deps: AppDependencies, session: AuthSession) {
  const state = WorkspaceStatusSchema.parse(await deps.getWorkspace(session));
  const detail_operations = { business: "business.get", email: "sending-accounts.get channel=email", linkedin: "sending-accounts.get channel=linkedin",
    campaign: "campaigns.get", targeting: "targeting.get", voice: "commercial-voice.get" } as const;
  if (state.state === "needs_workspace" || state.state === "suspended") return WorkspaceSummarySchema.parse({
    observed_at: new Date().toISOString(), workspace: state, business: null, website: null, setup: null, email: null, linkedin: null, campaign: null, detail_operations,
  });
  const current = state.workspace.workspace_ref;
  const [config, website, email, linkedin, campaign] = await Promise.all([
    readComponent(async () => scoped(WorkspaceConfigSchema.parse(await deps.getConfig(session, null)), current)),
    readComponent(async () => scoped(BusinessWebsiteSchema.parse(await deps.getBusinessWebsite(session)), current)),
    readComponent(async () => {
      const v = scoped(EmailConnectionStatus.parse(await deps.getEmailConnection(session, current)), current);
      return { connection_status: v.status, identity: v.status === "not_connected" ? null : v.email,
        sending_enabled: v.status === "not_connected" ? null : v.sending_enabled,
        failure_code: v.status === "not_connected" ? null : v.failure_code };
    }),
    readComponent(async () => {
      const v = scoped(LinkedinConnectionStatus.parse(await deps.getLinkedinConnection(session, current)), current);
      return { connection_status: v.status, identity: v.status === "not_connected" ? null : v.profile_url,
        sending_enabled: v.status === "not_connected" ? null : v.sending_enabled,
        failure_code: v.status === "not_connected" ? null : v.failure_code };
    }),
    readComponent(async () => {
      const v = scoped(WorkspaceCampaignResult.parse(await deps.workspaceCampaign(session, { operation: "status", payload: { workspace: current } })), current);
      const cfg = v.configuration;
      const shared = cfg && "engine" in cfg ? cfg : null;
      return { state: v.state, outreach_enabled: v.outreach_enabled, version_ref: v.version_ref,
        selected_channels: [...(cfg?.email ? ["email" as const] : []), ...(cfg?.linkedin ? ["linkedin" as const] : [])],
        templates: { email: cfg?.email && "steps" in cfg.email ? cfg.email.steps.length : 0,
          linkedin: cfg?.linkedin && "messages" in cfg.linkedin ? cfg.linkedin.messages.length : 0 },
        engine: shared ? "shared_v1" as const : cfg ? "fixed_v1" as const : null,
        compose_modes: shared ? { email: shared.email?.compose_mode ?? null, linkedin: shared.linkedin?.compose_mode ?? null } : null,
        preparation: v.preparation ?? null,
        eligible_count: v.eligible_count, includes_future_leads: cfg?.audience.includes_future_leads ?? null,
        audience: cfg ? (cfg.audience.lead_ids ? "explicit_leads" as const : "qualified_ab" as const) : null,
        progress: v.progress, blockers: v.blockers, continuing_version_count: v.continuing_versions.length };
    }),
  ]);
  // Independently scoped RPCs must still refer to the same current membership.
  const after = WorkspaceStatusSchema.parse(await deps.getWorkspace(session));
  if (after.state === "needs_workspace" || after.state === "suspended" || after.workspace.workspace_ref !== current)
    throw new PublicError({ status: 409, code: "WORKSPACE_CHANGED", message: "The current workspace changed while reading. Retry the summary." });
  const unavailable = { status: "unavailable", next_action: "retry_read" } as const;
  const business = config.status === "available" && config.value.config.workspace
    ? { status: "available", value: { name: config.value.config.workspace.name, description: config.value.config.workspace.description } } : unavailable;
  const setup = config.status === "available" ? { status: "available", value: {
    targeting_saved: !!config.value.config.icp, research_saved: !!config.value.config.prompt, voice_saved: !!config.value.config.tone && Object.keys(config.value.config.tone.values).length > 0,
  } } : unavailable;
  return WorkspaceSummarySchema.parse({ observed_at: new Date().toISOString(), workspace: after, business, website, setup, email, linkedin, campaign, detail_operations });
}
