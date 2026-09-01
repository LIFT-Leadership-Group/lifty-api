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

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResult = z.infer<typeof CreateWorkspaceResultSchema>;
export type OnboardingSubmission = z.infer<typeof OnboardingSubmissionSchema>;
export type OnboardingPushResult = z.infer<typeof OnboardingPushResultSchema>;
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>;
export type HubspotConnectStart = z.infer<typeof HubspotConnectStartSchema>;
export type HubspotConnectionStatus = z.infer<typeof HubspotConnectionStatusSchema>;
