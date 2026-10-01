
import { CrmSyncReceiptSchema } from "./crm-sync-receipt.js";
import { z } from "@hono/zod-openapi";

const WorkspaceReferenceSchema = z
  .object({
    workspace_ref: z.string().min(1),
    name: z.string().min(1),
  })
  .strict();

export const WorkspaceStatusSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("needs_workspace"),
      workspace: z.null(),
      next_action: z.literal("provision_workspace"),
    })
    .strict(),
  z
    .object({
      state: z.enum(["ready_for_connections", "suspended"]),
      workspace: WorkspaceReferenceSchema,
      next_action: z.null(),
    })
    .strict(),
]);

const RunStartFields = {
    run_ref: z.string().min(1),
    requested_leads: z.number().int().positive(),
    workspace: WorkspaceReferenceSchema,
    attempt: z.number().int().nonnegative().optional(),
};

const CalibrationPolicySchema = z.enum(["tier_a_v1", "qualified_ab_v1", "researched_v1"]);

export const StartRunResultSchema = z.discriminatedUnion("state", [
  z.object({
    ...RunStartFields,
    state: z.enum(["queued", "running"]),
    created: z.boolean(),
    calibration_policy: CalibrationPolicySchema.optional(),
  }).strict(),
  z.object({
    ...RunStartFields,
    state: z.literal("failed"),
    created: z.literal(false),
    calibration_policy: z.literal("qualified_ab_v1"),
    error_code: z.literal("calibration_review_required"),
  }).strict(),
]);

const RunLeadSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    linkedin_url: z.string().nullable(),
    lead_ref: z.uuid().nullable().optional(),
    research_url: z.string().nullable().optional(),
    research_available: z.boolean().optional(),
    tier: z.string().nullable(),
    fit_rationale: z.string().nullable(),
    stage: z.string().nullable(),
  })
  .strict();

export const RunStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_discovered: z.number().int().nonnegative().nullable(),
      calibration_policy: CalibrationPolicySchema.optional(),
      leads_researched: z.number().int().nonnegative().nullable(),
      error_code: z.string().nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
      workspace: WorkspaceReferenceSchema,
      leads: z.array(RunLeadSchema).nullable(),
    })
    .strict(),
]);

/** Providers the integration routes accept. unipile is reserved: routed, not connectable yet. */
export const ProviderSchema = z.enum(["hubspot", "slack", "unipile"]);

export const HubspotConnectStartSchema = z
  .object({
    provider: z.literal("hubspot"),
    connect_url: z.string().url(),
    expires_in_seconds: z.number().int().positive(),
    attempt_ref: z.uuid().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const HubspotConnectionStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      provider: z.literal("hubspot"),
      status: z.literal("not_connected"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("hubspot"),
      status: z.literal("connected"),
      portal_id: z.string().regex(/^[0-9]{1,20}$/),
      hub_domain: z.string().nullable(),
      granted_scopes: z.array(z.string()),
      connected_at: z.string().nullable(),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

export const SlackConnectStartSchema = z
  .object({
    provider: z.literal("slack"),
    connect_url: z.string().url(),
    expires_in_seconds: z.number().int().positive(),
    attempt_ref: z.uuid().optional(),
    expires_at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const SlackConnectLinkSchema = SlackConnectStartSchema.extend({
  workspace_id: z.uuid(),
  workspace_name: z.string().min(1),
}).strict();
export type SlackConnectLink = z.infer<typeof SlackConnectLinkSchema>;

export const ProviderConnectStartSchema = z.union([
  HubspotConnectStartSchema,
  SlackConnectStartSchema,
]);
// Existing installed clients reject additional handoff keys. Keep the public
// legacy response distinct from internal results consumed by stage adapters.
export const LegacyProviderConnectStartSchema = z.union([
  HubspotConnectStartSchema.omit({ attempt_ref: true, expires_at: true }),
  SlackConnectStartSchema.omit({ attempt_ref: true, expires_at: true }),
]);

export const SlackConnectionStatusSchema = z.discriminatedUnion("status", [
  z
    .object({
      provider: z.literal("slack"),
      status: z.literal("not_connected"),
    })
    .strict(),
  z
    .object({
      provider: z.literal("slack"),
      status: z.literal("connected"),
      team_id: z.string().min(1),
      team_name: z.string().min(1),
      enterprise_id: z.string().nullable(),
      bot_user_id: z.string().min(1),
      scopes: z.array(z.string()),
      connected_at: z.string().nullable(),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

/** GET /v1/integrations/{provider}: hubspot reads the RPC; unipile has no connect path yet. */
export const IntegrationConnectionStatusSchema = z.union([
  HubspotConnectionStatusSchema,
  SlackConnectionStatusSchema,
  z
    .object({
      provider: z.literal("unipile"),
      status: z.literal("not_connected"),
    })
    .strict(),
]);

export const NotificationTypeSchema = z.enum([
  "reply.requires_action",
  "meeting.booked",
  "integration.disconnected",
  "system.test",
]);

export const SlackNotificationChannelSchema = z
  .object({
    id: z.string().regex(/^C[A-Z0-9]{2,31}$/),
    name: z.string().min(1).max(80),
    is_private: z.boolean(),
  })
  .strict();

export const SlackNotificationChannelsSchema = z
  .object({ channels: z.array(SlackNotificationChannelSchema) })
  .strict();

export const NotificationDestinationSchema = z
  .object({
    destination_ref: z.uuid(),
    provider: z.literal("slack"),
    external_id: z.string().regex(/^C[A-Z0-9]{2,31}$/),
    display_name: z.string().min(1).max(80),
    status: z.enum(["active", "unavailable", "archived"]),
  })
  .strict();

export const NotificationRouteSchema = z
  .object({
    route_ref: z.uuid(),
    notification_type: NotificationTypeSchema,
    destination_ref: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();

const NotificationSlackStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_connected") }).strict(),
  z
    .object({
      status: z.literal("connected"),
      team_id: z.string().min(1),
      team_name: z.string().min(1),
      reconnect_required: z.boolean(),
    })
    .strict(),
]);

export const NotificationConfigSchema = z
  .object({
    workspace_ref: z.uuid(),
    notification_types: z.array(NotificationTypeSchema),
    slack: NotificationSlackStatusSchema,
    destinations: z.array(NotificationDestinationSchema),
    routes: z.array(NotificationRouteSchema),
  })
  .strict();

export const UpsertNotificationDestinationRequestSchema = z
  .object({
    channel_id: z.string().trim().regex(/^C[A-Z0-9]{2,31}$/),
    channel_name: z.string().trim().min(1).max(80),
  })
  .strict();

export const SetNotificationRouteRequestSchema = z
  .object({
    notification_type: NotificationTypeSchema,
    destination_ref: z.uuid(),
    enabled: z.boolean(),
  })
  .strict();

export const NotificationTestResultSchema = z
  .object({
    delivery_ref: z.uuid(),
    destination_ref: z.uuid(),
    status: z.literal("queued"),
  })
  .strict();

/** What DELETE /v1/integrations/{provider} returns to the CLI. */
export const DisconnectResponseSchema = z
  .object({
    provider: ProviderSchema,
    status: z.literal("disconnected"),
    portal_id: z.string().nullable(),
    disconnected_at: z.string().min(1),
    workspace: WorkspaceReferenceSchema,
  })
  .strict();

/**
 * Exact shape of the disconnect_lifty_integration RPC result. `revocation_ref`
 * (LIF-681) names the detached grant the `lifty-integration-revoke` job must
 * revoke at the provider; it stays internal to the API.
 */
export const DisconnectResultSchema = DisconnectResponseSchema.extend({
  revocation_ref: z.string().nullable().optional(),
}).strict();

export const StartCrmSyncResultSchema = z
  .object({
    state: z.enum(["queued", "running"]),
    run_ref: z.string().min(1),
    requested_leads: z.number().int().positive(),
    portal_id: z.string().regex(/^[0-9]{1,20}$/).nullable(),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

export const CrmSyncStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["queued", "running", "succeeded", "failed"]),
      run_ref: z.string().min(1),
      requested_leads: z.number().int().positive(),
      leads_synced: z.number().int().nonnegative().nullable(),
      error_code: z.string().nullable(),
      crm_sync_receipt: CrmSyncReceiptSchema.nullable().optional(),
      portal_id: z.string().regex(/^[0-9]{1,20}$/).nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
      workspace: WorkspaceReferenceSchema,
    })
    .strict(),
]).superRefine((result, ctx) => {
  if (result.state === "succeeded" && result.crm_sync_receipt && result.crm_sync_receipt.status !== "complete") {
    ctx.addIssue({ code: "custom", message: "A successful sync requires complete delivery" });
  }
});

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type StartRunResult = z.infer<typeof StartRunResultSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
export type Provider = z.infer<typeof ProviderSchema>;
export type HubspotConnectStart = z.infer<typeof HubspotConnectStartSchema>;
export type HubspotConnectionStatus = z.infer<typeof HubspotConnectionStatusSchema>;
export type SlackConnectStart = z.infer<typeof SlackConnectStartSchema>;
export type SlackConnectionStatus = z.infer<typeof SlackConnectionStatusSchema>;
export type IntegrationConnectionStatus = z.infer<typeof IntegrationConnectionStatusSchema>;
export type DisconnectResult = z.infer<typeof DisconnectResultSchema>;
export type StartCrmSyncResult = z.infer<typeof StartCrmSyncResultSchema>;
export type CrmSyncStatus = z.infer<typeof CrmSyncStatusSchema>;
export type NotificationType = z.infer<typeof NotificationTypeSchema>;
export type SlackNotificationChannels = z.infer<typeof SlackNotificationChannelsSchema>;
export type NotificationDestination = z.infer<typeof NotificationDestinationSchema>;
export type NotificationRoute = z.infer<typeof NotificationRouteSchema>;
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;
export type UpsertNotificationDestinationRequest = z.infer<
  typeof UpsertNotificationDestinationRequestSchema
>;
export type SetNotificationRouteRequest = z.infer<typeof SetNotificationRouteRequestSchema>;
export type NotificationTestResult = z.infer<typeof NotificationTestResultSchema>;
