import { randomBytes } from "node:crypto";

import { createApp } from "./app.js";
import { renderCliAuthPage } from "./cli-auth-page.js";
import { loadConfig, type ServiceConfig } from "./config.js";
import { PublicError } from "./errors.js";
import { createHubspotConnectOperations } from "./hubspot-connect.js";
import { buildAuthorizationUrl } from "./hubspot-oauth.js";
import {
  createSlackConnectOperations,
  SlackCallbackError,
} from "./slack-connect.js";
import { buildSlackAuthorizationUrl } from "./slack-oauth.js";
import {
  createSupabaseAuthenticator,
  createSupabaseReadinessCheck,
} from "./supabase-auth.js";
import {
  createConfigUpdateTrigger,
  createCrmSyncTrigger,
  createFirstRunTrigger,
  createIntegrationRevocationTrigger,
  createNotificationDeliveryTrigger,
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
  getNotificationConfig,
  listSlackNotificationChannels,
  upsertNotificationDestination,
  setNotificationRoute,
  enqueueNotificationTest,
  requeueConfigUpdate,
  startCrmSyncRun,
  startRun,
  submitConfigUpdate,
  submitOnboarding,
} from "./workspace-operations.js";

export function createProductionApp(config: ServiceConfig) {
  const hubspot = createHubspotConnectOperations(config.hubspot);
  const slackSettings = config.slack;
  const slack = slackSettings
    ? createSlackConnectOperations(slackSettings)
    : null;
  const slackUnavailable = () => {
    throw new PublicError({
      status: 503,
      code: "INTEGRATION_NOT_CONFIGURED",
      message: "The Slack connection service is not configured.",
    });
  };
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
    enqueueIntegrationRevocation: createIntegrationRevocationTrigger(config.trigger),
    enqueueNotificationDelivery: createNotificationDeliveryTrigger(config.trigger),
    getNotificationConfig,
    listSlackNotificationChannels,
    upsertNotificationDestination,
    setNotificationRoute,
    enqueueNotificationTest,
    startHubspotConnect: hubspot.startConnect,
    getHubspotConnection: hubspot.getConnection,
    completeHubspotCallback: hubspot.completeCallback,
    buildHubspotAuthorizeUrl: (state) => buildAuthorizationUrl({
      clientId: config.hubspot.clientId,
      redirectUri: `${config.hubspot.publicBaseUrl}/hubspot/callback`,
      state,
    }),
    startSlackConnect: slack?.startConnect ?? (async () => slackUnavailable()),
    getSlackConnection: slack?.getConnection ?? (async () => slackUnavailable()),
    completeSlackCallback: slack?.completeCallback ?? (async () => {
      throw new SlackCallbackError(
        "server_misconfigured",
        503,
        "The Slack connection service is not configured.",
      );
    }),
    buildSlackAuthorizeUrl: slackSettings
      ? (state) => buildSlackAuthorizationUrl({
          clientId: slackSettings.clientId,
          redirectUri: `${slackSettings.publicBaseUrl}/slack/callback`,
          state,
        })
      : () => null,
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
