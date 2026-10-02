import { z } from "zod";
import type { AppDependencies, AuthSession } from "./app.js";
import {
  BusinessGetSchema,
  BusinessProfileSchema,
  TargetingGetSchema,
  CriteriaGetSchema,
  VoiceGetSchema,
  SetupStatusSchema,
} from "./business-contracts.js";
import { RunErrorCodeSchema, WorkspaceStatusSchema } from "./contracts.js";
import { CampaignsSchema, JourneysSchema, ExactRevisionSchema } from "./outreach-contracts.js";
import { PublicError } from "./errors.js";
import { SenderSchema, SendersGetSchema } from "./identity-contracts.js";
import { ResearchScheduleSchema } from "./research-operations.js";

export const readResult = <T extends z.ZodType>(schema: T) =>
  z.discriminatedUnion("status", [
    z.object({ status: z.literal("available"), value: schema }).strict(),
    z
      .object({
        status: z.literal("unavailable"),
        next_action: z.literal("retry_read"),
      })
      .strict(),
  ]);
export type ReadResult<T> =
  | { status: "available"; value: T }
  | { status: "unavailable"; next_action: "retry_read" };
const WORKSPACE_SCOPE_CONFLICTS = new Set([
  "WORKSPACE_CHANGED",
  "WORKSPACE_UNAVAILABLE",
  "WORKSPACE_MISSING",
  "WORKSPACE_SELECTION_REQUIRED",
  "WORKSPACE_SUSPENDED",
]);
// Never convert an authentication/scope failure into an incomplete success.
export async function readComponent<T>(
  read: () => Promise<T>,
): Promise<ReadResult<T>> {
  try {
    return { status: "available", value: await read() };
  } catch (error) {
    if (
      error instanceof PublicError &&
      ([401, 403].includes(error.status) ||
        WORKSPACE_SCOPE_CONFLICTS.has(error.code))
    )
      throw error;
    return { status: "unavailable", next_action: "retry_read" };
  }
}
function scoped<T extends { workspace_ref: string }>(
  value: T,
  current: string,
): T {
  if (value.workspace_ref !== current)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "Workspace state changed. Read the current workspace again.",
    });
  return value;
}
const Campaign = z.object({
  campaigns_next_cursor: z.uuid().nullable(), journeys_next_cursor: z.uuid().nullable(),
  campaigns: z.array(z.object({ campaign_ref: z.uuid(), journey_ref: z.uuid(), version: z.number().int().positive(),
    name: z.string(), channel: z.enum(["email", "linkedin"]), state: z.enum(["inactive", "active", "paused"]),
    active_revision: ExactRevisionSchema.nullable(), draft_revision: ExactRevisionSchema, draft_approved: z.boolean(),
  }).strict()).max(100),
  journeys: z.array(z.object({ journey_ref: z.uuid(), version: z.number().int().positive(), name: z.string(),
    active_revision: ExactRevisionSchema.nullable(), executable_version: JourneysSchema.shape.journeys.element.shape.executable_version,
    draft_revision: ExactRevisionSchema, draft_approved: z.boolean(),
  }).strict()).max(100),
}).strict();
const SummaryRunSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_discovered: z.number().int().nonnegative().nullable(),
      leads_researched: z.number().int().nonnegative().nullable(),
      error_code: RunErrorCodeSchema.nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
    })
    .strict(),
]);
const SummaryCrmSchema = z
  .object({
    available: z.literal(true),
    connected: z.boolean(),
    portal_id: z.string().nullable(),
    hub_domain: z.string().nullable(),
    connected_at: z.string().nullable(),
    reconnect_required: z.boolean(),
    sync_pending: z.boolean(),
    last_sync_at: z.string().nullable(),
    last_sync: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }).strict(),
      z
        .object({
          state: z.enum(["queued", "running", "succeeded", "failed"]),
          run_ref: z.string().min(1),
          requested_leads: z.number().int().positive(),
          leads_synced: z.number().int().nonnegative().nullable(),
          error_code: z.string().nullable(),
          started_at: z.string().min(1),
          completed_at: z.string().nullable(),
        })
        .strict(),
    ]),
  })
  .strict();
type Read<K extends keyof AppDependencies> = AppDependencies[K] extends (
  ...args: never[]
) => Promise<infer T>
  ? T
  : never;
// Aggregate reads retain independent research and CRM receipts.
export const runOverview = (
  run: Read<"getRunStatus">,
): z.infer<typeof SummaryRunSchema> =>
  run.state === "none"
    ? { state: "none" }
    : {
        state: run.state,
        run_ref: run.run_ref,
        requested_leads: run.requested_leads,
        leads_discovered: run.leads_discovered,
        leads_researched: run.leads_researched,
        error_code: run.error_code,
        started_at: run.started_at,
        completed_at: run.completed_at,
      };
export const hubspotOverview = (
  hubspot: Read<"getHubspotConnection">,
  sync: Read<"getCrmSyncStatus">,
): z.infer<typeof SummaryCrmSchema> => ({
  available: true,
  connected: hubspot.status === "connected",
  portal_id: hubspot.status === "connected" ? hubspot.portal_id : null,
  hub_domain: hubspot.status === "connected" ? hubspot.hub_domain : null,
  connected_at: hubspot.status === "connected" ? hubspot.connected_at : null,
  reconnect_required:
    hubspot.status === "connected" ? hubspot.reconnect_required : false,
  sync_pending: sync.state === "queued" || sync.state === "running",
  last_sync_at: sync.state === "none" ? null : sync.completed_at,
  last_sync:
    sync.state === "none"
      ? { state: "none" }
      : {
          state: sync.state,
          run_ref: sync.run_ref,
          requested_leads: sync.requested_leads,
          leads_synced: sync.leads_synced,
          error_code: sync.error_code,
          started_at: sync.started_at,
          completed_at: sync.completed_at,
        },
});
export const WorkspaceSummarySchema = z
  .object({
    observed_at: z.iso.datetime(),
    workspace: WorkspaceStatusSchema,
    business: readResult(BusinessProfileSchema).nullable(),
    setup: readResult(
      z
        .object({
          targeting_saved: z.boolean(),
          research_saved: z.boolean(),
          voice_saved: z.boolean(),
          targeting_version: z.number().int().positive().nullable(),
          criteria_version: z.number().int().positive().nullable(),
          profile_version: z.number().int().positive(),
          voice_version: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ).nullable(),
    setup_status: readResult(SetupStatusSchema).nullable(),
    run: readResult(SummaryRunSchema).nullable(),
    research_schedule: readResult(
      ResearchScheduleSchema.pick({ state: true, weekly_target: true, effective_target: true }),
    ).nullable(),
    crm: readResult(SummaryCrmSchema).nullable(),
    // The same people and accounts as senders.get, read without provider checks.
    senders: readResult(z.array(SenderSchema)).nullable(),
    campaign: readResult(Campaign).nullable(),
    detail_operations: z
      .object({
        business: z.literal("business.get"),
        senders: z.literal("senders.get"),
        sending_accounts: z.literal("sending-accounts.get"),
        campaign: z.literal("campaigns.get"),
        targeting: z.literal("targeting.get"),
        voice: z.literal("commercial-voice.get"),
      })
      .strict(),
  })
  .strict();
// The session forwards the caller's workspace selection; every read resolves
// the same workspace through the shared database rule.
export async function getWorkspaceSummary(
  deps: AppDependencies,
  session: AuthSession,
) {
  const reads = session;
  const state = WorkspaceStatusSchema.parse(await deps.getWorkspace(reads));
  const detail_operations = {
    business: "business.get",
    senders: "senders.get",
    sending_accounts: "sending-accounts.get",
    campaign: "campaigns.get",
    targeting: "targeting.get",
    voice: "commercial-voice.get",
  } as const;
  if (state.state === "needs_workspace")
    return WorkspaceSummarySchema.parse({
      observed_at: new Date().toISOString(),
      workspace: state,
      business: null,
      setup: null,
      senders: null,
      campaign: null,
      setup_status: null,
      run: null,
      research_schedule: null,
      crm: null,
      detail_operations,
    });
  const current = state.workspace.workspace_ref;
  const [
    business,
    targeting,
    criteria,
    voice,
    senders,
    campaign,
    setup_status,
    run,
    research_schedule,
    crm,
  ] = await Promise.all([
    readComponent(async () => {
      const value = BusinessGetSchema.parse(
        await deps.businessOperation(session, "business.get"),
      );
      if (value.workspace?.workspace_ref !== current || !value.profile)
        throw new PublicError({
          status: 403,
          code: "WORKSPACE_FORBIDDEN",
          message: "Business state changed workspace.",
        });
      return value.profile;
    }),
    readComponent(
      async () =>
        scoped(
          TargetingGetSchema.parse(
            await deps.businessOperation(session, "targeting.get"),
          ),
          current,
        ).targeting,
    ),
    readComponent(
      async () =>
        scoped(
          CriteriaGetSchema.parse(
            await deps.businessOperation(session, "research-criteria.get"),
          ),
          current,
        ).criteria,
    ),
    readComponent(
      async () =>
        scoped(
          VoiceGetSchema.parse(
            await deps.businessOperation(session, "commercial-voice.get"),
          ),
          current,
        ).voice,
    ),
    readComponent(async () => {
      const result = await deps.identityOperation(session, "senders.get", { path: {}, query: {}, body: undefined });
      const value = SendersGetSchema.parse(result.body);
      if (value.workspace.workspace_ref !== current)
        throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Identity state changed workspace." });
      return value.senders;
    }),
    readComponent(async () => {
      const campaigns = CampaignsSchema.parse(await deps.outreachOperation(session, "campaigns.get", { path: {}, query: { limit: 20 }, body: undefined }));
      const journeys = JourneysSchema.parse(await deps.outreachOperation(session, "journeys.get", { path: {}, query: { limit: 20 }, body: undefined }));
      if (campaigns.workspace.workspace_ref !== current || journeys.workspace.workspace_ref !== current)
        throw new PublicError({ status: 403, code: "WORKSPACE_FORBIDDEN", message: "Outreach state changed workspace." });
      return {
        campaigns_next_cursor: campaigns.next_cursor, journeys_next_cursor: journeys.next_cursor,
        campaigns: campaigns.campaigns.map(value => ({ campaign_ref: value.campaign_ref, journey_ref: value.journey_ref, version: value.version,
          name: value.name, channel: value.channel, state: value.state, active_revision: value.active_revision ? { revision_ref: value.active_revision.revision_ref, digest: value.active_revision.digest } : null,
          draft_revision: { revision_ref: value.draft_revision.revision_ref, digest: value.draft_revision.digest }, draft_approved: value.draft_revision.approval !== null })),
        journeys: journeys.journeys.map(value => ({ journey_ref: value.journey_ref, version: value.version, name: value.name,
          active_revision: value.active_revision ? { revision_ref: value.active_revision.revision_ref, digest: value.active_revision.digest } : null,
          executable_version: value.executable_version,
          draft_revision: { revision_ref: value.draft_revision.revision_ref, digest: value.draft_revision.digest }, draft_approved: value.draft_revision.approval !== null })),
      };
    }),
    readComponent(async () =>
      scoped(
        SetupStatusSchema.parse(
          await deps.businessOperation(session, "setup.status"),
        ),
        current,
      ),
    ),
    readComponent(async () => {
      const value = await deps.getRunStatus(reads);
      if (value.state !== "none") scoped(value.workspace, current);
      return runOverview(value);
    }),
    // A failed read is unknown (retry_read), never paused or zero.
    readComponent(async () => {
      const { state, weekly_target, effective_target } = ResearchScheduleSchema.parse(
        await deps.researchOperation(session, "research-schedule.get", { query: {}, body: undefined }),
      );
      return { state, weekly_target, effective_target };
    }),
    readComponent(async () => {
      const [hubspot, sync] = await Promise.all([
        deps.getHubspotConnection(reads),
        deps.getCrmSyncStatus(reads),
      ]);
      if (sync.state !== "none") scoped(sync.workspace, current);
      return hubspotOverview(hubspot, sync);
    }),
  ]);
  // Independently scoped RPCs must still refer to the same current membership.
  const after = WorkspaceStatusSchema.parse(await deps.getWorkspace(reads));
  if (
    after.state === "needs_workspace" ||
    after.workspace.workspace_ref !== current
  )
    throw new PublicError({
      status: 409,
      code: "WORKSPACE_CHANGED",
      message:
        "The current workspace changed while reading. Retry the summary.",
    });
  const unavailable = {
    status: "unavailable",
    next_action: "retry_read",
  } as const;
  const setup =
    business.status === "available" &&
    targeting.status === "available" &&
    criteria.status === "available" &&
    voice.status === "available"
      ? {
          status: "available",
          value: {
            targeting_saved: !!targeting.value,
            research_saved: !!criteria.value?.text,
            voice_saved: !!voice.value.tone || voice.value.rules.length > 0,
            targeting_version: targeting.value?.version ?? null,
            criteria_version: criteria.value?.version ?? null,
            profile_version: business.value.version,
            voice_version: voice.value.version,
          },
        }
      : unavailable;
  return WorkspaceSummarySchema.parse({
    observed_at: new Date().toISOString(),
    workspace: after,
    business,
    setup,
    senders,
    campaign,
    setup_status,
    run,
    research_schedule,
    crm,
    detail_operations,
  });
}
