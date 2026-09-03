import { z } from "zod";

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

export const CreateWorkspaceRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: z.string().max(4000).nullable().optional(),
  })
  .strict();

export const CreateWorkspaceResultSchema = z
  .object({
    state: z.enum(["ready_for_connections", "suspended"]),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

export const SubmitOnboardingRequestSchema = z
  .object({
    draft: z.record(z.string(), z.unknown()),
  })
  .strict();

/** Exact shape of the submit_lifty_onboarding RPC result. */
export const OnboardingSubmissionSchema = z
  .object({
    state: z.literal("submitted"),
    submission_ref: z.string().min(1),
    draft_digest: z.string().startsWith("sha256:"),
    import_status: z.enum(["pending", "imported", "failed"]),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

/** What POST /v1/onboarding returns to the CLI. */
export const OnboardingPushResultSchema = z
  .object({
    state: z.enum(["queued", "imported"]),
    run_id: z.string().min(1).nullable(),
    submission_ref: z.string().min(1),
    draft_digest: z.string().startsWith("sha256:"),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

const OnboardingIcpSummarySchema = z
  .object({
    version: z.number().int().positive(),
    label: z.string().nullable(),
    person_locations: z.array(z.string()).nullable(),
    organization_industries: z.array(z.string()).nullable(),
    organization_num_employees_ranges: z.array(z.string()).nullable(),
    person_seniorities: z.array(z.string()).nullable(),
    personas: z.array(
      z.object({ name: z.string(), titles: z.array(z.string()) }).strict(),
    ),
  })
  .strict();

const OnboardingPromptSummarySchema = z
  .object({
    agent: z.literal("scout"),
    chars: z.number().int().positive(),
    published: z.literal(true),
  })
  .strict();

/** Exact shape of the get_lifty_onboarding_status RPC result. */
export const OnboardingStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: z.enum(["pending", "failed"]),
      submission_ref: z.string().min(1),
      draft_digest: z.string().startsWith("sha256:"),
      submitted_at: z.string().min(1),
      /** Short reason token, present only once the import failed with one (LIF-681), e.g. prompt_hand_tuned. */
      error_code: z.string().nullable().optional(),
      workspace: WorkspaceReferenceSchema,
      summary: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("imported"),
      submission_ref: z.string().min(1),
      draft_digest: z.string().startsWith("sha256:"),
      submitted_at: z.string().min(1),
      error_code: z.null().optional(),
      workspace: WorkspaceReferenceSchema,
      summary: z
        .object({
          icp: OnboardingIcpSummarySchema.nullable(),
          prompt: OnboardingPromptSummarySchema.nullable(),
        })
        .strict(),
    })
    .strict(),
]);

export const StartRunResultSchema = z
  .object({
    state: z.enum(["queued", "running"]),
    run_ref: z.string().min(1),
    requested_leads: z.number().int().positive(),
    workspace: WorkspaceReferenceSchema,
    created: z.boolean(),
  })
  .strict();

const RunLeadSchema = z
  .object({
    name: z.string(),
    title: z.string().nullable(),
    company: z.string().nullable(),
    linkedin_url: z.string().nullable(),
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
  })
  .strict();

export const ProviderConnectStartSchema = z.union([
  HubspotConnectStartSchema,
  SlackConnectStartSchema,
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
      portal_id: z.string().regex(/^[0-9]{1,20}$/).nullable(),
      started_at: z.string().min(1),
      completed_at: z.string().nullable(),
      workspace: WorkspaceReferenceSchema,
    })
    .strict(),
]);

// ---------------------------------------------------------------- P6 config

export const ConfigSectionSchema = z.enum(["icp", "tone", "prompt", "workspace"]);

const ConfigPersonaSchema = z.looseObject({
  name: z.string(),
  titles: z.array(z.string()),
});

const ConfigIcpSchema = z
  .object({
    version: z.number().int().positive(),
    digest: z.string().startsWith("sha256:"),
    label: z.string().nullable(),
    person_locations: z.array(z.string()).nullable(),
    organization_industries: z.array(z.string()).nullable(),
    organization_num_employees_ranges: z.array(z.string()).nullable(),
    person_seniorities: z.array(z.string()).nullable(),
    contact_email_status: z.string(),
    q_organization_domains_list: z.array(z.string()).nullable(),
    q_keywords: z.string().nullable(),
    personas: z.array(ConfigPersonaSchema),
    max_stale_days: z.number().int(),
    reject_extrapolated: z.boolean(),
    daily_target: z.number().int().nullable(),
  })
  .strict();

const ConfigToneSchema = z
  .object({
    version: z.string().startsWith("sha256:"),
    values: z.record(z.string(), z.unknown()),
  })
  .strict();

const ConfigPromptSchema = z
  .object({
    version: z.string().min(1),
    digest: z.string().startsWith("sha256:"),
    source: z.string(),
    text: z.string(),
  })
  .strict();

const ConfigWorkspaceSchema = z
  .object({
    version: z.string().startsWith("sha256:"),
    name: z.string(),
    description: z.string().nullable(),
  })
  .strict();

/** Exact shape of the get_lifty_config RPC result (sections present per filter). */
export const WorkspaceConfigSchema = z
  .object({
    workspace_ref: z.string().min(1),
    config: z
      .object({
        icp: ConfigIcpSchema.nullable().optional(),
        tone: ConfigToneSchema.optional(),
        prompt: ConfigPromptSchema.nullable().optional(),
        workspace: ConfigWorkspaceSchema.optional(),
      })
      .strict(),
  })
  .strict();

const ConfigValuesSchema = z.record(z.string(), z.unknown());

/** PATCH /v1/config body: one section with values, the prompt instruction form, or a full-config object. */
export const ConfigUpdateRequestSchema = z.union([
  z
    .object({
      section: z.literal("prompt"),
      instruction: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      section: z.enum(["icp", "tone", "workspace"]),
      values: ConfigValuesSchema,
    })
    .strict(),
  z.object({ values: ConfigValuesSchema }).strict(),
]);

const ConfigUpdateStateSchema = z.enum(["queued", "applied", "unchanged", "failed"]);
const ImportStatusSchema = z.enum(["pending", "imported", "failed"]);
const ArtifactActionsSchema = z.record(z.string(), z.string());

/**
 * Shape of the submit_lifty_config_update RPC result. A digest replay returns
 * the stored receipt, which carries the completion summary once the job
 * landed — hence the optional completion fields and the loose object; the
 * route projects it onto the strict public result below.
 */
export const ConfigUpdateSubmissionSchema = z.looseObject({
  state: ConfigUpdateStateSchema,
  submission_ref: z.string().min(1),
  run_ref: z.string().nullable(),
  import_status: ImportStatusSchema,
  changed_sections: z.array(ConfigSectionSchema),
  artifact_actions: ArtifactActionsSchema,
  regenerate_icp: z.boolean(),
  regenerate_prompt: z.boolean(),
  workspace_ref: z.string().min(1),
  created: z.boolean(),
  icp_version: z.number().int().nullable().optional(),
  prompt_chars: z.number().int().nullable().optional(),
  prompt_version: z.string().nullable().optional(),
  error_code: z.string().nullable().optional(),
  /** Set once the row was requeued after a failure; keys the retry enqueue (LIF-681). */
  requeued_at: z.string().nullable().optional(),
});

/** What PATCH /v1/config returns to the CLI. */
export const ConfigUpdateResultSchema = z
  .object({
    state: ConfigUpdateStateSchema,
    submission_ref: z.string().min(1),
    run_ref: z.string().min(1).nullable(),
    import_status: ImportStatusSchema,
    changed_sections: z.array(ConfigSectionSchema),
    artifact_actions: ArtifactActionsSchema,
    workspace_ref: z.string().min(1),
    created: z.boolean(),
    icp_version: z.number().int().nullable(),
    prompt_chars: z.number().int().nullable(),
    prompt_version: z.string().nullable(),
    error_code: z.string().nullable(),
  })
  .strict();

/** Exact shape of the get_lifty_config_update_status RPC result. */
export const ConfigUpdateStatusSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("none") }).strict(),
  z
    .object({
      state: ConfigUpdateStateSchema,
      submission_ref: z.string().min(1),
      import_status: ImportStatusSchema,
      run_ref: z.string().nullable(),
      changed_sections: z.array(ConfigSectionSchema),
      artifact_actions: ArtifactActionsSchema,
      regenerate_icp: z.boolean(),
      regenerate_prompt: z.boolean(),
      icp_version: z.number().int().nullable(),
      prompt_chars: z.number().int().nullable(),
      prompt_version: z.string().nullable(),
      error_code: z.string().nullable(),
      /** Present only once the row was requeued after a failure (LIF-681). */
      requeued_at: z.string().nullable().optional(),
      submitted_at: z.string().min(1),
      updated_at: z.string().min(1),
      workspace: WorkspaceReferenceSchema,
    })
    .strict(),
]);

// ---------------------------------------------------------------- P6 status

const OverviewSyncSchema = z.discriminatedUnion("state", [
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
]);

/** GET /v1/status: one aggregate read so `lifty status` never needs OAuth to answer health. */
export const WorkspaceOverviewSchema = z
  .object({
    workspace: z.discriminatedUnion("state", [
      z.object({ state: z.literal("needs_workspace") }).strict(),
      z
        .object({
          state: z.enum(["ready_for_connections", "suspended"]),
          workspace_ref: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ]),
    onboarding: z.discriminatedUnion("state", [
      z.object({ state: z.literal("none") }).strict(),
      z
        .object({
          state: z.enum(["pending", "imported", "failed"]),
          submission_ref: z.string().min(1),
          submitted_at: z.string().min(1),
          error_code: z.string().nullable(),
        })
        .strict(),
    ]),
    run: z.discriminatedUnion("state", [
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
    ]),
    config_update: ConfigUpdateStatusSchema,
    integrations: z
      .object({
        hubspot: z
          .object({
            available: z.literal(true),
            connected: z.boolean(),
            portal_id: z.string().nullable(),
            hub_domain: z.string().nullable(),
            connected_at: z.string().nullable(),
            reconnect_required: z.boolean(),
            sync_pending: z.boolean(),
            last_sync_at: z.string().nullable(),
            last_sync: OverviewSyncSchema,
          })
          .strict(),
        unipile: z
          .object({
            available: z.literal(false),
            connected: z.literal(false),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResult = z.infer<typeof CreateWorkspaceResultSchema>;
export type OnboardingSubmission = z.infer<typeof OnboardingSubmissionSchema>;
export type OnboardingPushResult = z.infer<typeof OnboardingPushResultSchema>;
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;
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
export type ConfigSection = z.infer<typeof ConfigSectionSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type ConfigUpdateRequest = z.infer<typeof ConfigUpdateRequestSchema>;
export type ConfigUpdateSubmission = z.infer<typeof ConfigUpdateSubmissionSchema>;
export type ConfigUpdateResult = z.infer<typeof ConfigUpdateResultSchema>;
export type ConfigUpdateStatus = z.infer<typeof ConfigUpdateStatusSchema>;
export type WorkspaceOverview = z.infer<typeof WorkspaceOverviewSchema>;
