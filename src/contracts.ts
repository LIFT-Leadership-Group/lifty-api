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

export const ProvisioningResultSchema = z
  .object({
    state: z.literal("ready_for_connections"),
    workspace: WorkspaceReferenceSchema,
    draft_digest: z.string().startsWith("sha256:"),
  })
  .strict();

export const ProvisionRequestSchema = z
  .object({
    draft: z.record(z.string(), z.unknown()),
  })
  .strict();

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
export type ProvisioningResult = z.infer<typeof ProvisioningResultSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResult = z.infer<typeof CreateWorkspaceResultSchema>;
export type HubspotConnectStart = z.infer<typeof HubspotConnectStartSchema>;
export type HubspotConnectionStatus = z.infer<typeof HubspotConnectionStatusSchema>;
