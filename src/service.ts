import { createOAuthConfirmation } from "./oauth-confirmation.js";
import { openHubspotConnectIntent } from "./hubspot-state.js";
import { openSlackConnectIntent } from "./slack-state.js";
import { createRunProgressReader } from "./run-progress.js";
import { createWorkspaceCampaignOperations } from "./workspace-campaign.js";
import { createCompanyReadinessCheck } from "./company-mapping/readiness.js";
import { createCrmMappingReadinessCheck } from "./crm-mapping/readiness.js";
import { createCompanyMapping } from "./company-mapping.js";
import { createCrmMapping } from "./crm-mapping.js";
import { createLinkedinConnectOperations } from "./linkedin-connect.js";
import { createLinkedinCampaignOperations } from "./linkedin-campaign.js";
import { createWorkspaceRetirement } from "./workspace-retirement.js";
import { deleteOwnLogin } from "./login-deletion.js";
import { listMemberWorkspaces } from "./member-workspaces.js";
import { createEmailCampaignOperations } from "./email-campaign.js";
import { createEmailConnectOperations } from "./email-connect.js";
import { createEmailAccountOperations } from "./email-accounts.js";
import { createClientEmailOperations } from "./client-email-connect.js";
import { createEmailWarmupOperations } from "./email-warmup.js";
import { createEmailConnectionPlacementOperations } from "./email-connection-placement.js";
import { createEmailDeliverabilityOperations } from "./email-deliverability.js";
import { createPlacementReportReader } from "./email-deliverability-placement.js";
import { createWarmupSetup } from "./warmup-setup.js";

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
import { createCrmSyncTrigger, createCrmMappingTrigger, createFirstRunTrigger, createIntegrationRevocationTrigger, createNotificationDeliveryTrigger } from "./trigger-client.js";
import { disconnectIntegration, getCrmSyncStatus, getRunStatus, getWorkspaceStatus, getNotificationConfig, listSlackNotificationChannels, upsertNotificationDestination, setNotificationRoute, enqueueNotificationTest, startCrmSyncRun, startRun } from "./workspace-operations.js";

export function createProductionApp(config: ServiceConfig) {
  const linkedin = config.linkedin ? createLinkedinConnectOperations(config.linkedin) : null;
  const email = config.email ? createEmailConnectOperations(config.email) : null;
  const clientEmail=config.email ? createClientEmailOperations(config.email) : null;
  const emailAccounts=clientEmail ?? createEmailAccountOperations(config.supabase);
  // Workspace member operations use their session. Browser setup uses a narrow,
  // server-key-protected intent RPC, never a Supabase administrative key.
  const warmupSetup = config.warmupSetup ? createWarmupSetup(config.warmupSetup) : null;
  const placement = createEmailConnectionPlacementOperations();
  const warmup = createEmailWarmupOperations({ mailivery: config.mailivery ?? null,
    ...(warmupSetup ? {issueSetupLink:warmupSetup.issue} : {}) });
  // Reads use the caller's session; only report reads for authorized tests use the server-side key.
  const deliverability = createEmailDeliverabilityOperations({
    readPlacementDetails: createPlacementReportReader({ smartleadApiKey: config.smartleadApiKey ?? null }) });
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
    connectionCallbacks:{
      hubspot:createOAuthConfirmation({provider:"hubspot",origin:new URL(config.hubspot.publicBaseUrl).origin,...config.supabase,
        open:state=>openHubspotConnectIntent(state,config.hubspot.clientSecret),complete:hubspot.completeCallback}),
      ...(slack && slackSettings ? {slack:createOAuthConfirmation({provider:"slack",origin:new URL(slackSettings.publicBaseUrl).origin,...config.supabase,
        open:state=>openSlackConnectIntent(state,slackSettings.clientSecret),complete:slack.completeCallback})} : {}),
    },
    validateConnectionReturn:(flow,state)=>{
      const operation=flow==="email"?email:flow==="linkedin"?linkedin:clientEmail;
      if(!operation)throw new SyntaxError("unavailable");operation.validateReturn(state);
    },
    ...(config.openAiAppsChallenge === undefined ? {} : { openAiAppsChallenge: config.openAiAppsChallenge }),
    ...(config.mcp ? {
      mcp: { ...config.mcp, authenticate: createSupabaseAuthenticator(config.supabase, { oauthResource: config.mcp.resourceUrl }) },
      renderOAuthConsentPage: (authorizationId: string) => {
        const scriptNonce = randomBytes(18).toString("base64url");
        return { html: renderCliAuthPage({ supabaseUrl: config.supabase.supabaseUrl,
          publishableKey: config.supabase.publishableKey, authorizationId, scriptNonce }),
          scriptNonce, connectOrigin: new URL(config.supabase.supabaseUrl).origin };
      },
    } : {}),
    getEmailDeliverability: deliverability.read,
    getEmailPlacement: placement.status,
    startEmailPlacement: placement.start,
    getEmailAccounts:emailAccounts.accounts,
    connectEmailAccount:emailAccounts.connect,
    getEmailAccountAttempt:emailAccounts.status,
    ...(clientEmail ? {authorizeClientEmail:clientEmail.authorize,receiveClientEmailV2Return:clientEmail.v2Return} : {}),
    ...(warmupSetup ? {warmupSetup} : {}),
    ...(config.unipileV2HostedAuthOrigins ? {unipileV2HostedAuthOrigins:config.unipileV2HostedAuthOrigins} : {}),
    ...(config.unipileHostedAuthOrigin ? { unipileHostedAuthOrigin: config.unipileHostedAuthOrigin } : {}),
    ...((config.email?.serverKey ?? config.linkedin?.serverKey) ? { workspaceCampaign: createWorkspaceCampaignOperations((config.email?.serverKey ?? config.linkedin?.serverKey)!) } : {}),
    ...(linkedin ? {
      linkedinCampaign: createLinkedinCampaignOperations(config.linkedin!.serverKey),
      startLinkedinConnect: linkedin.start,
      getLinkedinConnection: linkedin.status,
      disconnectLinkedin: linkedin.disconnect,
      authorizeLinkedin: linkedin.authorize,
      completeLinkedinCallback: linkedin.callback,
      receiveLinkedinV2Return: linkedin.v2Return,
    } : {}),
    ...(email ? {
      emailAvailable: true,
      emailAuthorizationOrigin: new URL(config.email!.publicBaseUrl).origin,
      emailCampaign: createEmailCampaignOperations(config.email!.serverKey),
      startEmailConnect: email.start,
      getEmailConnection: email.status,
      disconnectEmail: email.disconnect,
      authorizeEmail: email.authorize,
      declareEmail: email.declare,
      completeEmailCallback: email.callback,
      receiveEmailV2Return: email.v2Return,
      getEmailWarmup: warmup.status,
      startEmailWarmup: warmup.start,
      changeEmailWarmup: (session, workspace, operation, connectionRef) => warmup[operation](session, workspace, connectionRef),
    } : {}),
    retireWorkspace: createWorkspaceRetirement(),
    deleteOwnLogin,
    authenticate: createSupabaseAuthenticator(config.supabase),
    getWorkspace: getWorkspaceStatus,
    listMemberWorkspaces,
    startRun,
    getRunStatus: session => getRunStatus(session, config.dashboardOrigin),
    getRunProgress: createRunProgressReader(),
    enqueueFirstRun: createFirstRunTrigger(config.trigger),
    startCrmSyncRun,
    getCrmSyncStatus,
    enqueueCrmSync: createCrmSyncTrigger(config.trigger),
    disconnectIntegration,
    enqueueIntegrationRevocation: createIntegrationRevocationTrigger(config.trigger),
    enqueueNotificationDelivery: createNotificationDeliveryTrigger(config.trigger),
    getNotificationConfig,
    listSlackNotificationChannels,
    companyMapping: createCompanyMapping(config.crm ?? null),
    runCrmMapping: createCrmMapping(config.crm ? { ...config.crm, enqueue: createCrmMappingTrigger(config.trigger) } : null),
    upsertNotificationDestination,
    setNotificationRoute,
    enqueueNotificationTest,
    startHubspotConnect: hubspot.startConnect,
    getHubspotConnection: hubspot.getConnection,
    completeHubspotCallback: hubspot.completeCallback,
    denyHubspotCallback: hubspot.denyCallback,
    buildHubspotAuthorizeUrl: (state) => buildAuthorizationUrl({
      clientId: config.hubspot.clientId,
      redirectUri: `${config.hubspot.publicBaseUrl}/hubspot/callback`,
      state,
    }),
    createSlackConnectLink: slack?.createConnectLink ?? (async () => slackUnavailable()),
    startSlackConnect: slack?.startConnect ?? (async () => slackUnavailable()),
    getSlackConnection: slack?.getConnection ?? (async () => slackUnavailable()),
    denySlackCallback: slack?.denyCallback ?? (async () => slackUnavailable()),
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
    checkCrmMappingReadiness: createCrmMappingReadinessCheck(config.supabase, config.crm ?? null),
  });
}

export function createDeploymentApp(
  environment: Record<string, string | undefined> = process.env,
) {
  return createProductionApp(loadConfig(environment));
}
