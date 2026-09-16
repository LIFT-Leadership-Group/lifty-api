import { z } from "zod";

export const EmailPolicy = z.discriminatedUnion("version", [
  z.object({ version: z.literal("strict.v1"), revision: z.uuid().nullable(), placement_required: z.literal(true), habitual_only: z.literal(false) }).strict(),
  z.object({ version: z.literal("lifty.personal-beta.v1"), revision: z.uuid(), placement_required: z.literal(false), habitual_only: z.literal(true) }).strict(),
]);

export const EmailConnectRequest = z.object({
  workspace: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
  email: z.email().max(254).transform(value => value.toLowerCase()).optional(),
  mailbox_use: z.enum(["personal", "outreach"]).optional(),
  reconnect: z.boolean().optional(),
}).strict().refine(value => (value.email === undefined) === (value.mailbox_use === undefined), "Supply both legacy mailbox fields or let the hosted flow select the account.");
export type EmailConnectInput = z.infer<typeof EmailConnectRequest>;

const profile = {
  provider: z.literal("unipile"), channel: z.literal("email"),
  workspace_ref: z.uuid(), email: z.email().nullable(), mailbox_use: z.enum(["personal", "outreach"]).nullable(),
  daily_limit: z.number().int().min(1).max(10),
  email_policy: EmailPolicy.optional(),
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
  z.object({ ...profile, status: z.literal("pending"), connect_url: z.url(), intent_ref: z.uuid(), expires_in_seconds: z.number().int().min(1).max(1800), expires_at: z.iso.datetime({ offset: true }).optional() }).strict(),
  z.object({ ...profile, status: z.literal("connected"), connection_ref: z.uuid() }).strict(),
]);
// Preserve the original public handoff for installed clients; stages consume
// the full internal result above and expose their own attempt contract.
export const LegacyEmailConnectResult = z.discriminatedUnion("status", [
  EmailConnectResult.options[0].omit({ expires_at: true }),
  EmailConnectResult.options[1],
]);
export type EmailStatus = z.infer<typeof EmailConnectionStatus>;
export type EmailStart = z.infer<typeof EmailConnectResult>;
