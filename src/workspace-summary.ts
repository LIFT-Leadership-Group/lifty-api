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
import { WorkspaceStatusSchema } from "./contracts.js";
import { EmailConnectionStatus } from "./email-contracts.js";
import { LinkedinConnectionStatus } from "./linkedin-contracts.js";
import { WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { PublicError } from "./errors.js";
import { EmailAccountsResult } from "./email-accounts-contracts.js";
import type { MemberWorkspacesOutput } from "./member-workspaces.js";

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
const Account = z
  .object({
    connection_status: z.enum([
      "not_connected",
      "pending",
      "connected",
      "disconnected",
      "failed",
    ]),
    identity: z.string().nullable(),
    sending_enabled: z.boolean().nullable(),
    failure_code: z.string().nullable(),
  })
  .strict();
const Campaign = z
  .object({
    state: WorkspaceCampaignResult.shape.state,
    outreach_enabled: z.boolean(),
    version_ref: z.uuid().nullable(),
    selected_channels: z.array(z.enum(["email", "linkedin"])),
    templates: z
      .object({ email: z.number().int(), linkedin: z.number().int() })
      .strict(),
    engine: z.enum(["fixed_v1", "shared_v1"]).nullable(),
    compose_modes: z
      .object({
        email: z.enum(["generate", "templates"]).nullable(),
        linkedin: z.enum(["generate", "templates"]).nullable(),
      })
      .strict()
      .nullable(),
    preparation: WorkspaceCampaignResult.shape.preparation.nullable(),
    eligible_count: z.number().int(),
    includes_future_leads: z.boolean().nullable(),
    audience: z.enum(["qualified_ab", "explicit_leads"]).nullable(),
    progress: WorkspaceCampaignResult.shape.progress,
    blockers: WorkspaceCampaignResult.shape.blockers,
    continuing_version_count: z.number().int(),
  })
  .strict();
const SummaryRunSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_discovered: z.number().int().nonnegative().nullable(),
      leads_researched: z.number().int().nonnegative().nullable(),
      error_code: z.string().nullable(),
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
// Client (LIFT-managed) workspaces hold several mailboxes per sender.
const Mailboxes = z
  .object({
    senders: z.number().int().nonnegative(),
    accounts: z
      .array(
        EmailAccountsResult.shape.accounts.element
          .omit({ sender_ref: true })
          .extend({ sender_name: z.string().nullable() })
          .strict(),
      )
      .max(10000),
  })
  .strict();

export const WorkspaceSummarySchema = z
  .object({
    observed_at: z.iso.datetime(),
    workspace: WorkspaceStatusSchema,
    // true for a Lifty-created workspace, false for a LIFT-managed client one,
    // null when the summary describes the caller's default without a selection.
    self_service: z.boolean().nullable(),
    mailboxes: readResult(Mailboxes).nullable(),
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
    crm: readResult(SummaryCrmSchema).nullable(),
    email: readResult(Account).nullable(),
    linkedin: readResult(Account).nullable(),
    campaign: readResult(Campaign).nullable(),
    detail_operations: z
      .object({
        business: z.literal("business.get"),
        email: z.literal("sending-accounts.get channel=email"),
        linkedin: z.literal("sending-accounts.get channel=linkedin"),
        campaign: z.literal("campaigns.get"),
        targeting: z.literal("targeting.get"),
        voice: z.literal("commercial-voice.get"),
      })
      .strict(),
  })
  .strict();
type MemberWorkspace = MemberWorkspacesOutput["workspaces"][number];
// The session forwards the caller's workspace selection; every read resolves
// the same workspace through the shared database rule.
export async function getWorkspaceSummary(
  deps: AppDependencies,
  session: AuthSession,
) {
  const reads = session;
  const state = WorkspaceStatusSchema.parse(await deps.getWorkspace(reads));
  const target =
    state.state === "needs_workspace"
      ? null
      : ((await deps.listMemberWorkspaces(session)).workspaces.find(
          (item) => item.workspace_ref === state.workspace.workspace_ref,
        ) ?? null);
  const client = target !== null && !target.self_service;
  const self_service = target?.self_service ?? null;
  const detail_operations = {
    business: "business.get",
    email: "sending-accounts.get channel=email",
    linkedin: "sending-accounts.get channel=linkedin",
    campaign: "campaigns.get",
    targeting: "targeting.get",
    voice: "commercial-voice.get",
  } as const;
  if (state.state === "needs_workspace")
    return WorkspaceSummarySchema.parse({
      observed_at: new Date().toISOString(),
      workspace: state,
      self_service,
      mailboxes: null,
      business: null,
      setup: null,
      email: null,
      linkedin: null,
      campaign: null,
      setup_status: null,
      run: null,
      crm: null,
      detail_operations,
    });
  const current = state.workspace.workspace_ref;
  const [
    business,
    targeting,
    criteria,
    voice,
    email,
    linkedin,
    campaign,
    setup_status,
    run,
    crm,
    mailboxes,
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
    // A client workspace has no single founder mailbox; its accounts are in mailboxes.
    client
      ? Promise.resolve(null)
      : readComponent(async () => {
          const v = scoped(
            EmailConnectionStatus.parse(
              await deps.getEmailConnection(session, current),
            ),
            current,
          );
          return {
            connection_status: v.status,
            identity: v.status === "not_connected" ? null : v.email,
            sending_enabled:
              v.status === "not_connected" ? null : v.sending_enabled,
            failure_code: v.status === "not_connected" ? null : v.failure_code,
          };
        }),
    readComponent(async () => {
      const v = scoped(
        LinkedinConnectionStatus.parse(
          await deps.getLinkedinConnection(session, current),
        ),
        current,
      );
      return {
        connection_status: v.status,
        identity: v.status === "not_connected" ? null : v.profile_url,
        sending_enabled:
          v.status === "not_connected" ? null : v.sending_enabled,
        failure_code: v.status === "not_connected" ? null : v.failure_code,
      };
    }),
    readComponent(async () => {
      const v = scoped(
        WorkspaceCampaignResult.parse(
          await deps.workspaceCampaign(session, {
            operation: "status",
            payload: { workspace: current },
          }),
        ),
        current,
      );
      const cfg = v.configuration;
      const shared = cfg && "engine" in cfg ? cfg : null;
      return {
        state: v.state,
        outreach_enabled: v.outreach_enabled,
        version_ref: v.version_ref,
        selected_channels: [
          ...(cfg?.email ? ["email" as const] : []),
          ...(cfg?.linkedin ? ["linkedin" as const] : []),
        ],
        templates: {
          email:
            cfg?.email && "steps" in cfg.email ? cfg.email.steps.length : 0,
          linkedin:
            cfg?.linkedin && "messages" in cfg.linkedin
              ? cfg.linkedin.messages.length
              : 0,
        },
        engine: shared
          ? ("shared_v1" as const)
          : cfg
            ? ("fixed_v1" as const)
            : null,
        compose_modes: shared
          ? {
              email: shared.email?.compose_mode ?? null,
              linkedin: shared.linkedin?.compose_mode ?? null,
            }
          : null,
        preparation: v.preparation ?? null,
        eligible_count: v.eligible_count,
        includes_future_leads: cfg?.audience.includes_future_leads ?? null,
        audience: cfg
          ? cfg.audience.lead_ids
            ? ("explicit_leads" as const)
            : ("qualified_ab" as const)
          : null,
        progress: v.progress,
        blockers: v.blockers,
        continuing_version_count: v.continuing_versions.length,
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
    readComponent(async () => {
      const [hubspot, sync] = await Promise.all([
        deps.getHubspotConnection(reads),
        deps.getCrmSyncStatus(reads),
      ]);
      if (sync.state !== "none") scoped(sync.workspace, current);
      return hubspotOverview(hubspot, sync);
    }),
    client
      ? readComponent(async () => {
          const roster = EmailAccountsResult.parse(
            await deps.getEmailAccounts(session, { workspace: current }),
          );
          if (roster.workspace_ref !== current)
            throw new PublicError({
              status: 403,
              code: "WORKSPACE_FORBIDDEN",
              message:
                "Workspace state changed. Read the current workspace again.",
            });
          const names = new Map(
            roster.senders.map((sender) => [
              sender.sender_ref,
              sender.display_name,
            ]),
          );
          return {
            senders: roster.senders.length,
            accounts: roster.accounts.map(({ sender_ref, ...account }) => ({
              ...account,
              sender_name: names.get(sender_ref) ?? null,
            })),
          };
        })
      : Promise.resolve(null),
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
    self_service,
    mailboxes,
    business,
    setup,
    email,
    linkedin,
    campaign,
    setup_status,
    run,
    crm,
    detail_operations,
  });
}
