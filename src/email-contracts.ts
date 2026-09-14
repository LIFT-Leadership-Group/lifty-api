import { z } from "zod";

export const EmailConnectRequest = z.object({
  workspace: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.email().max(254).transform(value => value.toLowerCase()),
  mailbox_use: z.enum(["personal", "outreach"]),
}).strict();
export type EmailConnectInput = z.infer<typeof EmailConnectRequest>;

const profile = {
  provider: z.literal("unipile"), channel: z.literal("email"),
  workspace_ref: z.uuid(), email: z.email(), mailbox_use: z.enum(["personal", "outreach"]),
  daily_limit: z.number().int().min(1).max(10),
  warmup_required: z.boolean(), sending_enabled: z.literal(false),
};
export const EmailConnectionStatus = z.discriminatedUnion("status", [
  z.object({ provider: z.literal("unipile"), channel: z.literal("email"), workspace_ref: z.uuid(), status: z.literal("not_connected") }).strict(),
  z.object({ ...profile, status: z.enum(["pending", "connected", "disconnected", "failed"]),
    connection_ref: z.uuid().nullable(), intent_ref: z.uuid().nullable(),
    failure_code: z.enum(["identity_mismatch","provider_unavailable","link_failed"]).nullable(),
  }).strict(),
]);
export const EmailConnectResult = z.discriminatedUnion("status", [
  z.object({ ...profile, status: z.literal("pending"), connect_url: z.url(), intent_ref: z.uuid(), expires_in_seconds: z.number().int().min(1).max(1800) }).strict(),
  z.object({ ...profile, status: z.literal("connected"), connection_ref: z.uuid() }).strict(),
]);
export type EmailStatus = z.infer<typeof EmailConnectionStatus>;
export type EmailStart = z.infer<typeof EmailConnectResult>;
