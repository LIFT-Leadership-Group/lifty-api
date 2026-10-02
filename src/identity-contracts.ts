import { z } from "zod";
import { WorkspaceIdentitySchema } from "./business-contracts.js";

// LIF-1182 Identity resources: senders (people) and the sending accounts they
// own. The database owns validation, versions, observation freshness and send
// counts; these schemas are the published request/response contract.
const Id = z.uuid();
const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const Version = z.number().int().positive();

export const Channel = z.enum(["email", "linkedin"]);
export const SenderName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f@]+$/)
  .refine(value => !["linkedin", "email"].includes(value.toLowerCase()), "Use the person's name, not a channel or address.");
// The founder's own words: plain text, https links only. The database
// normalizes line endings and surrounding whitespace and stores at most 500.
export const Signature = z.string().min(1).max(500);
export const BookingUrl = z.url({ protocol: /^https$/ }).max(2048);

const Declaration = z.union([
  z.object({ mailbox_use: z.enum(["habitual", "dedicated"]), declared_by: Id.nullable(), declared_at: Timestamp }).strict(),
  z.object({ habitual_personal_account: z.literal(true), no_other_automation: z.literal(true),
    declared_by: Id.nullable(), declared_at: Timestamp }).strict(),
]);
export const AccountSchema = z.object({
  id: Id,
  sender_id: Id,
  channel: Channel,
  identity: z.string().min(1).max(2048).nullable(),
  status: z.enum(["connected", "needs_reconnect", "disconnected"]),
  state: z.enum(["active", "paused"]),
  checked_at: Timestamp.nullable(),
  observation: z.object({ state: z.enum(["verified", "unverified"]) }).strict(),
  connected_at: Timestamp.nullable(),
  disconnected_at: Timestamp.nullable(),
  access_revoked_at: Timestamp.nullable(),
  declaration: Declaration.nullable(),
  sends: z.object({ today: Count, last_7_days: Count }).strict(),
}).strict();
export type Account = z.infer<typeof AccountSchema>;
export const SenderSchema = z.object({
  id: Id,
  version: Version,
  name: z.string().min(1).max(200),
  signature: Signature.nullable(),
  booking_url: z.string().max(2048).nullable(),
  accounts: z.array(AccountSchema).max(1000),
}).strict();

const Workspace = { workspace: WorkspaceIdentitySchema };
export const SendersGetSchema = z.object({ ...Workspace, senders: z.array(SenderSchema).max(1000) }).strict();
export const SenderResultSchema = z.object({ ...Workspace, sender: SenderSchema }).strict();
export const SenderPatchResultSchema = SenderResultSchema.extend({ recomposing: Count.optional() }).strict();
export const SenderDeleteResultSchema = z.object({ ...Workspace,
  sender: z.object({ id: Id, version: Version, deleted_at: Timestamp }).strict(),
  accounts: z.array(AccountSchema).max(1000),
}).strict();
export const AccountsGetSchema = z.object({ ...Workspace, accounts: z.array(AccountSchema).max(5000) }).strict();
export const AccountResultSchema = z.object({ ...Workspace, account: AccountSchema }).strict();
export const AttemptSchema = z.object({
  ...Workspace,
  id: Id,
  sender_id: Id,
  channel: Channel,
  state: z.enum(["pending", "connected", "failed", "expired"]),
  reason: z.enum(["canceled", "account_in_use", "identity_mismatch", "provider_rejected"]).nullable(),
  account_id: Id.nullable(),
  declaration: Declaration.nullable(),
  expires_at: Timestamp,
}).strict();
export type Attempt = z.infer<typeof AttemptSchema>;
// The database opens or reuses the durable attempt; the API adds the link.
export const ConnectStartSchema = z.object({ ...Workspace, id: Id, expires_at: Timestamp, created: z.boolean() }).strict();
export const ConnectResultSchema = ConnectStartSchema.extend({ connection_url: z.url() }).strict();

export const IdPath = z.object({ id: Id }).strict();
export const SenderCreateSchema = z.object({
  name: SenderName, signature: Signature.optional(), booking_url: BookingUrl.optional(),
}).strict();
export const SenderPatchSchema = z.object({
  expected_version: Version,
  name: SenderName.optional(),
  signature: Signature.nullable().optional(),
  booking_url: BookingUrl.nullable().optional(),
}).strict().refine(value => value.name !== undefined || value.signature !== undefined || value.booking_url !== undefined,
  { message: "Change at least one of name, signature or booking_url.", path: [] });
export const SenderDeleteSchema = z.object({ expected_version: Version, confirm: z.literal(true) }).strict();
export const AccountsQuerySchema = z.object({ sender_id: Id.optional(), channel: Channel.optional() }).strict();
export const ConnectSchema = z.object({ sender_id: Id, channel: Channel }).strict();
export const DisconnectSchema = z.object({ confirm: z.literal(true) }).strict();
