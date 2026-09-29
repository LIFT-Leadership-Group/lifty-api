import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

export const DeleteLoginRequest = z.object({ confirm_email: z.string().trim().min(3).max(254) }).strict();
export const DeleteLoginResult = z.object({ deleted: z.literal(true), user_ref: z.uuid() }).strict();
export type DeleteLoginInput = z.infer<typeof DeleteLoginRequest>;
export type DeleteLoginOutput = z.infer<typeof DeleteLoginResult>;

const messages: Record<string, string> = {
  unauthenticated: "Sign in to Lifty before deleting your login.",
  login_not_found: "This login no longer exists.",
  login_delete_confirmation_mismatch: "Type the exact email of the login you are signed in with.",
  login_delete_workspace_membership: "This login still belongs to a workspace. Retire that workspace or leave it before deleting your login.",
  login_delete_history_retained: "This login authored workspace history that must be kept. Contact LIFT support to delete it.",
};

function failed(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const reason = parsed.success ? parsed.data.message ?? "" : "";
  const known = Object.hasOwn(messages, reason);
  const status = known && parsed.success && /^PT(400|401|404|409)$/.test(parsed.data.code ?? "") ? Number(parsed.data.code!.slice(2)) : 502;
  throw new PublicError({ status, code: known ? reason.toUpperCase() : "LOGIN_DELETION_UNAVAILABLE",
    message: known ? messages[reason]! : "Lifty could not confirm that your login was deleted. Check again before retrying." });
}

/** Deletes only the caller's own auth user; the database acts on auth.uid() alone. */
export async function deleteOwnLogin(session: AuthSession, input: DeleteLoginInput): Promise<DeleteLoginOutput> {
  const payload = DeleteLoginRequest.parse(input);
  const client = session.client as { rpc(name: string, args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  let result;
  try { result = await client.rpc("delete_lifty_own_login", { p_confirm_email: payload.confirm_email }); } catch { failed(null); }
  if (result.error) failed(result.error);
  const parsed = DeleteLoginResult.safeParse(result.data);
  if (!parsed.success || parsed.data.user_ref !== session.userId) failed(null);
  return parsed.data;
}
