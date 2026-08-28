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

export type WorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type ProvisioningResult = z.infer<typeof ProvisioningResultSchema>;
