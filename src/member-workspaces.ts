import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

// Membership discovery only. No field selects a workspace or a policy: the
// caller chooses and sends x-lifty-workspace. Other database keys are stripped.
export const MemberWorkspace = z.object({
  workspace_ref: z.uuid(), slug: z.string().min(1).max(100), name: z.string().min(1).max(500), active: z.boolean(),
});
export const MemberWorkspacesResult = z.object({ workspaces: z.array(MemberWorkspace).max(200) }).strict();
export type MemberWorkspacesOutput = z.infer<typeof MemberWorkspacesResult>;

function failed(error: unknown): never {
  const parsed = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  if (parsed.success && parsed.data.code === "PT401" && parsed.data.message === "unauthenticated") {
    throw new PublicError({ status: 401, code: "UNAUTHORIZED", message: "Sign in to Lifty to list your workspaces." });
  }
  throw new PublicError({ status: 502, code: "WORKSPACES_UNAVAILABLE", message: "Lifty could not read your workspaces. Try again." });
}

/** Lists only the caller's own memberships; the database filters on auth.uid(). */
export async function listMemberWorkspaces(session: AuthSession): Promise<MemberWorkspacesOutput> {
  const client = session.client as { rpc(name: string): Promise<{ data: unknown; error: unknown }> };
  let result;
  try { result = await client.rpc("lifty_member_workspaces"); } catch { failed(null); }
  if (result.error) failed(result.error);
  const parsed = MemberWorkspacesResult.safeParse(result.data);
  if (!parsed.success) failed(null);
  return parsed.data;
}
