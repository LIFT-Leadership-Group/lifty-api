import type { AuthSession } from "./app.js";

export const WORKSPACE_SELECTION_HEADER = "x-lifty-workspace";

interface SelectableClient {
  rpc(name: string, args?: Record<string, unknown>, options?: { get?: boolean }): { setHeader(name: string, value: string): PromiseLike<unknown> };
}

/**
 * LIF-1138: founder RPCs made through this session resolve the selected
 * membership instead of the caller's default. The database honors the
 * selection only inside read-only transactions (PostgREST GET), so it can
 * choose what is read but never where a write lands. Use it only for reads
 * that resolve their workspace implicitly.
 */
export function selectWorkspace(session: AuthSession, workspaceRef: string): AuthSession {
  const client = session.client as SelectableClient;
  return { ...session, client: {
    rpc: (name: string, args?: Record<string, unknown>) =>
      client.rpc(name, args ?? {}, { get: true }).setHeader(WORKSPACE_SELECTION_HEADER, workspaceRef),
  } };
}
