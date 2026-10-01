import type { AppDependencies, AuthSession } from "./app.js";
import { PublicError } from "./errors.js";
export async function resolveBusinessWorkspace(
  deps: Pick<AppDependencies, "listMemberWorkspaces">,
  session: AuthSession,
  selection?: string,
) {
  const memberships = (await deps.listMemberWorkspaces(session)).workspaces;
  const target = selection
    ? memberships.find(
        (item) => item.workspace_ref === selection || item.slug === selection,
      )
    : memberships.length === 1
      ? memberships[0]
      : null;
  if (selection && !target)
    throw new PublicError({
      status: 403,
      code: "WORKSPACE_FORBIDDEN",
      message: "You do not belong to this workspace.",
    });
  if (!selection && memberships.length > 1)
    throw new PublicError({
      status: 409,
      code: "WORKSPACE_SELECTION_REQUIRED",
      message: "Choose one of your workspaces before continuing.",
      workspaces: memberships.map(({ workspace_ref, name, slug }) => ({
        workspace_ref,
        name,
        slug,
      })),
    });
  return target ?? null;
}
