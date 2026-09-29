import { z } from "zod";
import type { AppDependencies, AuthSession } from "./app.js";
import { BusinessWebsiteSchema } from "./business-website.js";
import { ConfigUpdateStatusSchema, WorkspaceConfigSchema, WorkspaceOverviewSchema, WorkspaceStatusSchema, type WorkspaceConfig } from "./contracts.js";
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
const Overview = WorkspaceOverviewSchema.shape;
type Read<K extends keyof AppDependencies> = AppDependencies[K] extends (...args: never[]) => Promise<infer T> ? T : never;
// Shared with /v1/status so both reads describe onboarding, runs and HubSpot the same way.
export const onboardingOverview = (value: Read<"getOnboardingStatus">): z.infer<typeof Overview.onboarding> => value.state === "none"
  ? { state: "none" } : { state: value.state, submission_ref: value.submission_ref, submitted_at: value.submitted_at, error_code: value.error_code ?? null };
export const runOverview = (run: Read<"getRunStatus">): z.infer<typeof Overview.run> => run.state === "none" ? { state: "none" } : {
  state: run.state, run_ref: run.run_ref, requested_leads: run.requested_leads, leads_discovered: run.leads_discovered,
  leads_researched: run.leads_researched, error_code: run.error_code, started_at: run.started_at, completed_at: run.completed_at };
export const hubspotOverview = (hubspot: Read<"getHubspotConnection">, sync: Read<"getCrmSyncStatus">): z.infer<typeof Overview.integrations.shape.hubspot> => ({
  available: true, connected: hubspot.status === "connected",
  portal_id: hubspot.status === "connected" ? hubspot.portal_id : null,
  hub_domain: hubspot.status === "connected" ? hubspot.hub_domain : null,
  connected_at: hubspot.status === "connected" ? hubspot.connected_at : null,
  reconnect_required: hubspot.status === "connected" ? hubspot.reconnect_required : false,
  sync_pending: sync.state === "queued" || sync.state === "running",
  last_sync_at: sync.state === "none" ? null : sync.completed_at,
  last_sync: sync.state === "none" ? { state: "none" } : { state: sync.state, run_ref: sync.run_ref, requested_leads: sync.requested_leads,
    leads_synced: sync.leads_synced, error_code: sync.error_code, started_at: sync.started_at, completed_at: sync.completed_at },
});
// LIF-722: multi-lane ICPs are managed outside Lifty and refuse the ICP read.
// The other sections still read, so the summary never reports them as missing.
async function readConfig(deps: AppDependencies, session: AuthSession, current: string) {
  try { return { external: false, config: scoped(WorkspaceConfigSchema.parse(await deps.getConfig(session, null)), current).config }; }
  catch (error) {
    if (!(error instanceof PublicError && error.code === "MULTI_LANE_CONFIG_UNSUPPORTED")) throw error;
    const sections = await Promise.all((["workspace", "prompt", "tone"] as const).map(async section =>
      scoped(WorkspaceConfigSchema.parse(await deps.getConfig(session, section)), current).config));
    return { external: true, config: Object.assign({}, ...sections) as WorkspaceConfig["config"] };
  }
}

export const WorkspaceSummarySchema = z.object({
  observed_at: z.iso.datetime(), workspace: WorkspaceStatusSchema,
  business: readResult(z.object({ name: z.string(), description: z.string().nullable() }).strict()).nullable(),
  website: readResult(BusinessWebsiteSchema).nullable(),
  setup: readResult(z.object({ targeting_saved: z.boolean(), research_saved: z.boolean(), voice_saved: z.boolean(),
    icp_version: z.number().int().positive().nullable(), targeting_managed_externally: z.boolean() }).strict()).nullable(),
  onboarding: readResult(Overview.onboarding).nullable(), run: readResult(Overview.run).nullable(),
  config_update: readResult(ConfigUpdateStatusSchema).nullable(), crm: readResult(Overview.integrations.shape.hubspot).nullable(),
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
    observed_at: new Date().toISOString(), workspace: state, business: null, website: null, setup: null, email: null, linkedin: null, campaign: null,
    onboarding: null, run: null, config_update: null, crm: null, detail_operations,
  });
  const current = state.workspace.workspace_ref;
  const [config, website, email, linkedin, campaign, onboarding, run, config_update, crm] = await Promise.all([
    readComponent(() => readConfig(deps, session, current)),
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
    readComponent(async () => onboardingOverview(await deps.getOnboardingStatus(session))),
    readComponent(async () => runOverview(await deps.getRunStatus(session))),
    readComponent(async () => ConfigUpdateStatusSchema.parse(await deps.getConfigUpdateStatus(session, null))),
    readComponent(async () => {
      const [hubspot, sync] = await Promise.all([deps.getHubspotConnection(session), deps.getCrmSyncStatus(session)]);
      return hubspotOverview(hubspot, sync);
    }),
  ]);
  // Independently scoped RPCs must still refer to the same current membership.
  const after = WorkspaceStatusSchema.parse(await deps.getWorkspace(session));
  if (after.state === "needs_workspace" || after.state === "suspended" || after.workspace.workspace_ref !== current)
    throw new PublicError({ status: 409, code: "WORKSPACE_CHANGED", message: "The current workspace changed while reading. Retry the summary." });
  const unavailable = { status: "unavailable", next_action: "retry_read" } as const;
  const saved = config.status === "available" ? config.value.config : null;
  const business = saved?.workspace
    ? { status: "available", value: { name: saved.workspace.name, description: saved.workspace.description } } : unavailable;
  const setup = config.status === "available" && saved ? { status: "available", value: {
    targeting_saved: config.value.external || !!saved.icp, research_saved: !!saved.prompt, voice_saved: !!saved.tone && Object.keys(saved.tone.values).length > 0,
    icp_version: saved.icp?.version ?? null, targeting_managed_externally: config.value.external,
  } } : unavailable;
  return WorkspaceSummarySchema.parse({ observed_at: new Date().toISOString(), workspace: after, business, website, setup, email, linkedin, campaign,
    onboarding, run, config_update, crm, detail_operations });
}
