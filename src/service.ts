import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  createSupabaseAuthenticator,
  createSupabaseReadinessCheck,
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
    checkReadiness: createSupabaseReadinessCheck(config),
  });
}

export function createDeploymentApp(
  environment: Record<string, string | undefined> = process.env,
) {
  return createProductionApp(loadConfig(environment).supabase);
}
