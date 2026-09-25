import { z } from "zod";
import { EmailConnectRequest } from "./email-contracts.js";

export const EmailAccountsRequest = z.object({workspace: EmailConnectRequest.shape.workspace}).strict();
export const EmailAccountAttempt = z.string().min(32).max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
const email = z.email().max(254).refine(value => value === value.toLowerCase(), "Use the canonical email address.");
export const EmailAccountConnectRequest = EmailAccountsRequest.extend({sender_ref:z.uuid(), email:z.email().max(254).transform(value=>value.toLowerCase())});
export const EmailAccountStatusRequest = EmailAccountsRequest.extend({attempt_ref:EmailAccountAttempt});
export const EmailAccountsResult = z.object({
  workspace_ref:z.uuid(), workspace_slug:EmailConnectRequest.shape.workspace,
  senders:z.array(z.object({sender_ref:z.uuid(), display_name:z.string().max(200).regex(/^[^\u0000-\u001f\u007f]*$/)}).strict()).max(1000),
  accounts:z.array(z.object({connection_ref:z.uuid(),sender_ref:z.uuid(),email,
    status:z.enum(["connecting","connected","disconnected","revoked"]),campaign_send_paused:z.boolean()}).strict()).max(10000),
  campaign_release_required:z.literal(true),required_active_days:z.literal(21),
}).strict();
const identity = {provider:z.literal("unipile"),channel:z.literal("email"),workspace_ref:z.uuid(),sender_ref:z.uuid(),email};
export const EmailAccountConnectResult = z.object({...identity,status:z.literal("link_issued"),
  connection_url:z.url().max(8192),expires_at:z.iso.datetime({offset:true}),attempt_ref:EmailAccountAttempt}).strict();
export const EmailAccountStatusResult = z.object({...identity,
  status:z.enum(["connected","pending","needs_authorization","needs_reconnect","conflict","unavailable"]),
  connection_ref:z.uuid().nullable(),campaign_send_paused:z.boolean().nullable(),
}).strict().refine(value => value.status !== "connected" || (value.connection_ref !== null && value.campaign_send_paused !== null),
  {message:"A connected receipt requires its connection and campaign pause state."});
export type EmailAccountsInput = z.infer<typeof EmailAccountsRequest>;
export type EmailAccountsOutput = z.infer<typeof EmailAccountsResult>;
export type EmailAccountConnectInput = z.infer<typeof EmailAccountConnectRequest>;
export type EmailAccountConnectOutput = z.infer<typeof EmailAccountConnectResult>;
export type EmailAccountStatusInput = z.infer<typeof EmailAccountStatusRequest>;
export type EmailAccountStatusOutput = z.infer<typeof EmailAccountStatusResult>;
