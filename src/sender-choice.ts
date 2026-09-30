import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

export const SenderName = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f@]+$/)
  .refine(value => !["linkedin", "email"].includes(value.toLowerCase()), "Use the person's name.");
export const SenderChoice = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), sender_ref: z.uuid() }).strict(),
  z.object({ kind: z.literal("new"), name: SenderName }).strict(),
  z.object({ kind: z.literal("self"), name: SenderName.optional() }).strict(),
]);
export const SenderRoster = z.object({
  workspace_ref: z.uuid(),
  first_sender: z.object({ name: z.string().nullable(), is_current_user: z.boolean() }).strict(),
  senders: z.array(z.object({ sender_ref: z.uuid(), name: z.string().nullable(),
    connections: z.array(z.object({ connection_ref: z.uuid(), channel: z.enum(["email", "linkedin"]),
      email: z.email().nullable(), status: z.enum(["connecting", "connected", "disconnected", "revoked"]) }).strict()),
  }).strict()),
}).strict();
export const senderMessages: Record<string, string> = {
  sender_selection_required: "Choose an existing sender or create a new sender with the person's name.",
  sender_name_required: "What is the account creator's name? Use a person's name for the sender.",
  sender_invalid_choice: "Choose an existing sender, a named new sender, or the account creator for the first sender.",
  sender_workspace_forbidden: "Choose a sender from this workspace.",
  sender_selection_conflict: "This connection is already assigned to a sender. Continue with that sender; reconnecting cannot change ownership.",
  sender_signature_invalid: "Use a plain-text signature of at most 500 characters: no HTML, and links must start with https://.",
};
export function throwSenderError(error: unknown): void {
  const parsed = z.object({ message: z.string(), code: z.string().optional() }).safeParse(error);
  if (!parsed.success || !Object.hasOwn(senderMessages, parsed.data.message)) return;
  throw new PublicError({ code: parsed.data.message.toUpperCase(),
    status: parsed.data.code === "PT403" ? 403 : parsed.data.code === "PT400" ? 400 : 409,
    message: senderMessages[parsed.data.message]! });
}
export function verifySenderChoice(choice: z.infer<typeof SenderChoice> | undefined,
  value: { sender_ref?: string | undefined; sender_name?: string | undefined }): void {
  if (!choice) return;
  if (!value.sender_ref || (choice.kind === "existing" ? choice.sender_ref !== value.sender_ref
    : choice.name !== undefined && choice.name !== value.sender_name)) {
    throw new PublicError({ status: 503, code: "SENDER_SELECTION_UNAVAILABLE",
      message: "Lifty could not verify the selected sender. Retry after the connection service update." });
  }
}
export async function readSenderRoster(session: AuthSession, workspace: string) {
  const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  const { data, error } = await client.rpc("lifty_sender_roster", { p_workspace: workspace });
  if (error) throwSenderError(error);
  const result = SenderRoster.safeParse(data);
  if (error || !result.success || result.data.workspace_ref !== workspace) {
    throw new PublicError({ status: 503, code: "SENDER_ROSTER_UNAVAILABLE", message: "Lifty could not read the workspace's senders. Retry before connecting an account." });
  }
  return result.data;
}

// LIF-1163: Lifty appends the sender's plain-text signature to every campaign
// email. The database validates and normalizes it; readback proves the save.
const SignatureText = z.string().min(1).max(500);
export const SenderSignatureRequest = z.object({ sender_ref: z.uuid(), signature: z.string().min(1).max(2000) }).strict();
export const SenderSignatures = z.object({
  workspace_ref: z.uuid(),
  senders: z.array(z.object({ sender_ref: z.uuid(), name: z.string().nullable(), email_signature: SignatureText.nullable() }).strict()),
}).strict();
export const SenderSignatureResult = z.object({
  workspace_ref: z.uuid(), sender_ref: z.uuid(), email_signature: SignatureText, recomposing: z.number().int().nonnegative(),
}).strict();
const signatureUnavailable = () => new PublicError({ status: 503, code: "SENDER_SIGNATURE_UNAVAILABLE",
  message: "Lifty could not confirm the email signature. Read the signatures again before retrying." });
const normalizedSignature = (value: string) => value.replace(/\r\n/g, "\n").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
export async function readSenderSignatures(session: AuthSession, workspace: string) {
  const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  const { data, error } = await client.rpc("lifty_sender_signatures", { p_workspace: workspace });
  if (error) throwSenderError(error);
  const result = SenderSignatures.safeParse(data);
  if (error || !result.success || result.data.workspace_ref !== workspace) throw signatureUnavailable();
  return result.data;
}
export async function saveSenderSignature(session: AuthSession, workspace: string, input: z.infer<typeof SenderSignatureRequest>) {
  const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  const { data, error } = await client.rpc("lifty_sender_signature", { p_workspace: workspace, p_sender: input.sender_ref, p_signature: input.signature });
  if (error) throwSenderError(error);
  const result = SenderSignatureResult.safeParse(data);
  if (error || !result.success || result.data.workspace_ref !== workspace || result.data.sender_ref !== input.sender_ref
    || result.data.email_signature !== normalizedSignature(input.signature)) throw signatureUnavailable();
  return result.data;
}
