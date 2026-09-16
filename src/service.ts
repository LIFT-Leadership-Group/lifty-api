import { createCompanyReadinessCheck } from "./company-mapping/readiness.js";
import { createCompanyMapping } from "./company-mapping.js";
import { createLinkedinConnectOperations } from "./linkedin-connect.js";
import { createLinkedinCampaignOperations } from "./linkedin-campaign.js";
import { createAcquisitionRecoveryOperations } from "./acquisition-recovery.js";
import { getApolloAllowance } from "./apollo-allowance.js";
import { apolloCredentials } from "./apollo-credentials.js";
import { createWorkspaceRetirement } from "./workspace-retirement.js";
import { createEmailCampaignOperations } from "./email-campaign.js";
import { createEmailConnectOperations } from "./email-connect.js";

import { randomBytes } from "node:crypto";

import { createApp } from "./app.js";
import { renderCliAuthPage } from "./cli-auth-page.js";
import { renderPasswordRecoveryPage } from "./password-recovery-page.js";
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
  createAcquisitionVerificationTrigger,
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
  getOnboardingContext,
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
  const linkedin = config.linkedin ? createLinkedinConnectOperations(config.linkedin) : null;
  const email = config.email ? createEmailConnectOperations(config.email) : null;
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
    acquisitionRecovery: createAcquisitionRecoveryOperations({
      enqueueVerification: createAcquisitionVerificationTrigger(config.trigger),
      enqueueFirstRun: createFirstRunTrigger(config.trigger),
    }),
    getApolloAllowance,
    apolloCredentials,
    ...(linkedin ? {
      linkedinCampaign: createLinkedinCampaignOperations(config.linkedin!.serverKey),
      startLinkedinConnect: linkedin.start,
      getLinkedinConnection: linkedin.status,
      disconnectLinkedin: linkedin.disconnect,
      authorizeLinkedin: linkedin.authorize,
      completeLinkedinCallback: linkedin.callback,
    } : {}),
    ...(email ? {
      emailAvailable: true,
      emailCampaign: createEmailCampaignOperations(config.email!.serverKey),
      retireWorkspace: createWorkspaceRetirement(config.email!.serverKey),
      startEmailConnect: email.start,
      getEmailConnection: email.status,
      disconnectEmail: email.disconnect,
      authorizeEmail: email.authorize,
      completeEmailCallback: email.callback,
    } : {}),
    authenticate: createSupabaseAuthenticator(config.supabase),
    getWorkspace: getWorkspaceStatus,
    createWorkspace,
    submitOnboarding,
    getOnboardingContext,
    getOnboardingStatus,
    enqueueOnboardingImport: createOnboardingImportTrigger(config.trigger),
    startRun,
    getRunStatus: session => getRunStatus(session, config.dashboardOrigin),
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
    companyMapping: createCompanyMapping(config.crm ?? null),
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
    createSlackConnectLink: slack?.createConnectLink ?? (async () => slackUnavailable()),
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
    renderPasswordRecoveryPage: (page) => {
      const scriptNonce = randomBytes(18).toString("base64url");
      return {
        html: renderPasswordRecoveryPage({
          supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey,
          publicBaseUrl: config.hubspot.publicBaseUrl,
          scriptNonce, page,
        }),
        scriptNonce, connectOrigin: new URL(config.supabase.supabaseUrl).origin,
      };
    },
    checkReadiness: createSupabaseReadinessCheck(config.supabase),
    checkCompanyReadiness: createCompanyReadinessCheck(config.supabase, config.crm ?? null),
  });
}

export function createDeploymentApp(
  environment: Record<string, string | undefined> = process.env,
) {
  return createProductionApp(loadConfig(environment));
}
