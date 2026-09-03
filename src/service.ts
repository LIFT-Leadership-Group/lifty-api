import { randomBytes } from "node:crypto";

import { createApp } from "./app.js";
import { renderCliAuthPage } from "./cli-auth-page.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import { createHubspotConnectOperations } from "./hubspot-connect.js";
import { buildAuthorizationUrl } from "./hubspot-oauth.js";
import {
  createSupabaseAuthenticator,
  createSupabaseReadinessCheck,
} from "./supabase-auth.js";
import {
  createConfigUpdateTrigger,
  createCrmSyncTrigger,
  createFirstRunTrigger,
  createOnboardingImportTrigger,
} from "./trigger-client.js";
import {
  createWorkspace,
  disconnectIntegration,
  getConfig,
  getConfigUpdateStatus,
  getCrmSyncStatus,
  getOnboardingStatus,
  getRunStatus,
  getWorkspaceStatus,
  requeueConfigUpdate,
  startCrmSyncRun,
  startRun,
  submitConfigUpdate,
  submitOnboarding,
} from "./workspace-operations.js";

export function createProductionApp(config: ServiceConfig) {
  const hubspot = createHubspotConnectOperations(config.hubspot);
  return createApp({
    authenticate: createSupabaseAuthenticator(config.supabase),
    getWorkspace: getWorkspaceStatus,
    createWorkspace,
    submitOnboarding,
    getOnboardingStatus,
    enqueueOnboardingImport: createOnboardingImportTrigger(config.trigger),
    startRun,
    getRunStatus,
    enqueueFirstRun: createFirstRunTrigger(config.trigger),
    startCrmSyncRun,
    getCrmSyncStatus,
    enqueueCrmSync: createCrmSyncTrigger(config.trigger),
    getConfig,
    submitConfigUpdate,
    getConfigUpdateStatus,
    enqueueConfigUpdate: createConfigUpdateTrigger(config.trigger),
    requeueConfigUpdate,
    disconnectIntegration,
    startHubspotConnect: hubspot.startConnect,
    getHubspotConnection: hubspot.getConnection,
    completeHubspotCallback: hubspot.completeCallback,
    buildHubspotAuthorizeUrl: (state) => buildAuthorizationUrl({
      clientId: config.hubspot.clientId,
      redirectUri: `${config.hubspot.publicBaseUrl}/hubspot/callback`,
      state,
    }),
    renderCliAuthPage: (state, port) => {
      const scriptNonce = randomBytes(18).toString("base64url");
      return {
        html: renderCliAuthPage({
          supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey,
          state,
          port,
          scriptNonce,
        }),
        scriptNonce,
        connectOrigin: new URL(config.supabase.supabaseUrl).origin,
      };
    },
    checkReadiness: createSupabaseReadinessCheck(config.supabase),
  });
}

export function createDeploymentApp(
  environment: Record<string, string | undefined> = process.env,
) {
  return createProductionApp(loadConfig(environment));
}
