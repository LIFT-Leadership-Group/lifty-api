import { createHash } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "./app.js";
import { CONTEXT_FILES, contextFileUsage, type ContextDraft } from "./agent-context.js";
import { PublicError } from "./errors.js";

// LIF-1298: drafts of published context files, for a test workspace a LIFT
// admin marked in the ops dashboard. The database returns drafts only for a
// currently marked workspace, so every other workspace reads published files.

type Rpc = { rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

const ServedDrafts = z.object({
  workspace_ref: z.uuid(),
  drafts: z.array(z.object({
    draft_ref: z.uuid(),
    file: z.string(),
    revision: z.number().int().positive(),
    content: z.string().min(1).max(64000),
  })).max(64),
});

/** The caller's drafts. Any failed read serves published context: drafts are a
 * test aid and never stop a founder's agent (absent `drafts` shows it). */
export async function readContextDrafts(session: AuthSession, workspaceRef: string | null): Promise<ContextDraft[]> {
  try {
    const result = await (session.client as Rpc).rpc("get_lifty_context_drafts", { p_workspace_id: workspaceRef });
    if (result.error) return [];
    const parsed = ServedDrafts.safeParse(result.data);
    if (!parsed.success || (workspaceRef !== null && parsed.data.workspace_ref !== workspaceRef)) return [];
    // A draft of a file this release no longer ships has nothing to replace.
    return parsed.data.drafts.filter(draft => Object.hasOwn(CONTEXT_FILES, draft.file));
  } catch {
    return [];
  }
}

const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

const Actor = z.object({ user_ref: z.uuid(), email: z.string().nullable() }).nullable();
const AdminDrafts = z.object({
  test_workspaces: z.array(z.object({
    workspace_ref: z.uuid(), name: z.string(), slug: z.string(), reason: z.string(),
    marked_by: Actor, marked_at: z.string(),
  })),
  drafts: z.array(z.object({
    draft_ref: z.uuid(), file: z.string(), workspace_ref: z.uuid(),
    status: z.enum(["active", "discarded", "promoted"]),
    revision: z.number().int().positive(), base_sha256: z.string(), content: z.string(),
    created_by: Actor, created_at: z.string(), closed_by: Actor, closed_at: z.string().nullable(),
    promoted_revision: z.number().int().nullable(), pull_request_url: z.string().nullable(),
    revisions: z.array(z.object({
      revision: z.number().int().positive(), base_sha256: z.string(), size: z.number().int(),
      actor: Actor, recorded_at: z.string(),
    })),
  })),
});

/** Published files with their hash and where documents use them, plus the
 * drafts and test workspaces, for the ops editor. The database checks is_admin. */
export async function readAdminContext(session: AuthSession) {
  let result;
  try { result = await (session.client as Rpc).rpc("admin_list_lifty_context_drafts"); } catch { result = null; }
  const code = z.object({ code: z.string() }).safeParse(result?.error).data?.code;
  if (code === "PT401") throw new PublicError({ status: 401, code: "UNAUTHORIZED", message: "Sign in again." });
  if (code === "PT403") throw new PublicError({ status: 403, code: "ADMIN_REQUIRED", message: "Only LIFT admins can edit context drafts." });
  const parsed = result && !result.error ? AdminDrafts.safeParse(result.data) : null;
  if (!parsed?.success) throw new PublicError({ status: 502, code: "CONTEXT_DRAFTS_UNAVAILABLE", message: "Context drafts could not be read. Try again." });
  const usage = contextFileUsage();
  const files = Object.entries(CONTEXT_FILES).map(([file, content]) => ({
    file, sha256: sha256(content), size: content.length, content, used_by: usage[file] ?? [],
  }));
  const hashes = new Map(files.map(file => [file.file, file.sha256]));
  return {
    generated_at: new Date().toISOString(),
    files,
    test_workspaces: parsed.data.test_workspaces,
    // stale: the published file changed since the draft started from it, so
    // promoting it as is would undo that change.
    drafts: parsed.data.drafts.map(draft => ({
      ...draft,
      published: hashes.has(draft.file),
      stale: hashes.get(draft.file) !== draft.base_sha256,
    })),
  };
}
