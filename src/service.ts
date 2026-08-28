import { createApp } from "./app.js";
import {
  createSupabaseAuthenticator,
  type SupabaseAuthenticationConfig,
} from "./supabase-auth.js";
import {
  getWorkspaceStatus,
  provisionWorkspace,
} from "./workspace-operations.js";

export function createProductionApp(config: SupabaseAuthenticationConfig) {
  return createApp({
    authenticate: createSupabaseAuthenticator(config),
    getWorkspace: getWorkspaceStatus,
    provisionWorkspace,
  });
}
