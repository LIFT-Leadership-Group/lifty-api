import type { SupabaseEnv } from "@supabase/server";
import { parseHostedAuthOrigin } from "./hosted-auth-branding.js";

import type { SupabaseAuthenticationConfig } from "./supabase-auth.js";
import type { HubspotConnectSettings } from "./hubspot-connect.js";
import type { SlackConnectSettings } from "./slack-connect.js";

import type { LinkedinConnectSettings } from "./linkedin-connect.js";
import type { EmailConnectSettings } from "./email-connect.js";
import type { MailiverySettings } from "./email-warmup.js";

type Environment = Record<string, string | undefined>;

export interface ServiceConfig {
  unipileHostedAuthOrigin?: string;
  unipileV2HostedAuthOrigins?: string[];
  crm?: { serverKey: string; readOnly: boolean } | null;
  dashboardOrigin?: string;
  host: string;
  port: number;
  supabase: SupabaseAuthenticationConfig;
  hubspot: Omit<HubspotConnectSettings, "fetchImpl">;
  slack: Omit<SlackConnectSettings, "fetchImpl"> | null;
  email?: Omit<EmailConnectSettings, "fetchImpl"> | null;
  linkedin?: Omit<LinkedinConnectSettings, "fetchImpl"> | null;
  /** Mailivery warmup (LIF-989). Null keeps warmup start closed. */
  mailivery?: MailiverySettings | null;
  trigger: {
    apiUrl: string;
    secretKey: string;
  };
}

const FORBIDDEN_SECRET_NAMES = [
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SECRET_KEYS",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.[0-9]{1,3}){3}$/.test(hostname);
}

function secureUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new Error(`${name} must use HTTPS, except on a loopback host.`);
  }
  return url;
}

function parseJwks(environment: Environment): Exclude<SupabaseEnv["jwks"], null> {
  const inline = environment.SUPABASE_JWKS?.trim();
  if (inline) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inline);
    } catch {
      throw new Error("SUPABASE_JWKS must be valid JSON.");
    }
    const keys = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && "keys" in parsed
        ? (parsed as { keys: unknown }).keys
        : null;
    if (!Array.isArray(keys) || keys.length === 0) {
      throw new Error("SUPABASE_JWKS must contain a non-empty keys array.");
    }
    return { keys } as Exclude<SupabaseEnv["jwks"], URL | null>;
  }

  return secureUrl(
    required(environment, "SUPABASE_JWKS_URL"),
    "SUPABASE_JWKS_URL",
  );
}

function parsePort(value: string | undefined): number {
  const port = value === undefined || value.trim() === "" ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  return port;
}

export function loadConfig(environment: Environment = process.env): ServiceConfig {
  for (const name of FORBIDDEN_SECRET_NAMES) {
    if (environment[name]?.trim()) {
      throw new Error(
        "Secret Supabase credentials are forbidden in the LIFTY control plane.",
      );
    }
  }

  const supabaseUrl = secureUrl(
    required(environment, "SUPABASE_URL"),
    "SUPABASE_URL",
  );
  const publishableKey = required(environment, "SUPABASE_PUBLISHABLE_KEY");
  const publicBaseUrl = secureUrl(
    required(environment, "PUBLIC_BASE_URL"),
    "PUBLIC_BASE_URL",
  );
  const dashboardUrl = secureUrl(environment.LIFTY_DASHBOARD_ORIGIN?.trim() || "https://lift-gtm-dashboard.vercel.app", "LIFTY_DASHBOARD_ORIGIN");
  if (dashboardUrl.protocol !== "https:" || dashboardUrl.username || dashboardUrl.password || dashboardUrl.port || dashboardUrl.pathname !== "/" || dashboardUrl.search || dashboardUrl.hash) {
    throw new Error("LIFTY_DASHBOARD_ORIGIN must be an HTTPS origin without credentials, port or path.");
  }
  const slackClientId = environment.SLACK_CLIENT_ID?.trim();
  const slackClientSecret = environment.SLACK_CLIENT_SECRET?.trim();

  const providerValues = [environment.UNIPILE_DSN, environment.UNIPILE_ACCESS_TOKEN];
  const providerReady = providerValues.every(value => Boolean(value?.trim()));
  const v2Token=environment.UNIPILE_V2_ACCESS_TOKEN?.trim(), v2Application=environment.UNIPILE_V2_APPLICATION_ID?.trim();
  const v2Origins=environment.UNIPILE_V2_HOSTED_AUTH_ORIGINS?.trim();
  if(Boolean(v2Token)!==Boolean(v2Application) || (v2Origins && !v2Token))throw new Error("Unipile V2 requires UNIPILE_V2_ACCESS_TOKEN and UNIPILE_V2_APPLICATION_ID.");
  if(v2Application && !/^app_[A-Za-z0-9_-]+$/.test(v2Application))throw new Error("Invalid UNIPILE_V2_APPLICATION_ID.");
  const v2=v2Token && v2Application ? {accessToken:v2Token,applicationId:v2Application,
    hostedAuthOrigins:[...new Set(["https://auth.unipile.com",...(v2Origins?.split(",") ?? [])].map(value=>parseHostedAuthOrigin(value)))]} : undefined;
  if(v2?.hostedAuthOrigins.includes("https://account.unipile.com"))throw new Error("V2 cannot use the V1 hosted authentication origin.");
  const crmKey = environment.LIFTY_CRM_SERVER_KEY?.trim();
  if (crmKey && (crmKey.length < 32 || crmKey.length > 256)) throw new Error("LIFTY_CRM_SERVER_KEY must contain 32 to 256 characters.");
  const emailKey = environment.LIFTY_EMAIL_SERVER_KEY?.trim();
  const linkedinKey = environment.LIFTY_LINKEDIN_SERVER_KEY?.trim();
  const emailEnabled = Boolean(emailKey);
  const linkedinEnabled = Boolean(linkedinKey);
  if(v2 && !emailEnabled && !linkedinEnabled)throw new Error("Unipile V2 requires a dedicated connection service key.");
  if ((emailEnabled || linkedinEnabled) && !providerReady) throw new Error("Unipile requires both UNIPILE_DSN and UNIPILE_ACCESS_TOKEN.");
  if (providerValues.some(value => Boolean(value?.trim())) && !emailEnabled && !linkedinEnabled) throw new Error("Unipile requires a dedicated email or LinkedIn service key.");
  if (emailKey && emailKey.length < 32) throw new Error("LIFTY_EMAIL_SERVER_KEY must contain at least 32 characters.");
  if (linkedinKey && linkedinKey.length < 32) throw new Error("LIFTY_LINKEDIN_SERVER_KEY must contain at least 32 characters.");
  if (linkedinKey && linkedinKey === emailKey) throw new Error("LinkedIn requires a server key distinct from email.");
  const mailiveryKey = environment.MAILIVERY_API_KEY?.trim();
  if (mailiveryKey && (mailiveryKey.length < 16 || mailiveryKey.length > 512 || /\s/.test(mailiveryKey))) throw new Error("MAILIVERY_API_KEY must be a single token of 16 to 512 characters.");
  if (mailiveryKey && [emailKey, linkedinKey, crmKey, publishableKey].includes(mailiveryKey)) throw new Error("MAILIVERY_API_KEY must be distinct from LIFTY service keys.");
  if (crmKey && [emailKey, linkedinKey, publishableKey, environment.HUBSPOT_CLIENT_SECRET, environment.TRIGGER_SECRET_KEY].includes(crmKey)) throw new Error("CRM requires a distinct dedicated server key.");
  return {
    unipileHostedAuthOrigin: parseHostedAuthOrigin(environment.UNIPILE_HOSTED_AUTH_ORIGIN),
    ...(v2 ? {unipileV2HostedAuthOrigins:v2.hostedAuthOrigins} : {}),
    crm: crmKey ? { serverKey: crmKey, readOnly: [environment.DASHBOARD_READ_ONLY_MODE, environment.CONSUMER_READ_ONLY_MODE].some(value => value === "1" || value?.toLowerCase() === "true") } : null,
    dashboardOrigin: dashboardUrl.origin,
    mailivery: mailiveryKey ? { apiKey: mailiveryKey } : null,
    linkedin: linkedinEnabled ? {
      ...(v2 ? {v2} : {}),
      dsn: required(environment, "UNIPILE_DSN"), accessToken: required(environment, "UNIPILE_ACCESS_TOKEN"),
      serverKey: required(environment, "LIFTY_LINKEDIN_SERVER_KEY"),
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""), publishableKey,
    } : null,
    email: emailEnabled ? {
      ...(v2 ? {v2} : {}),
      dsn: required(environment,"UNIPILE_DSN"), accessToken: required(environment,"UNIPILE_ACCESS_TOKEN"),
      serverKey: required(environment,"LIFTY_EMAIL_SERVER_KEY"),
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""), publishableKey,
    } : null,
    host: environment.HOST?.trim() || "0.0.0.0",
    port: parsePort(environment.PORT),
    supabase: {
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
      publishableKey,
      jwks: parseJwks(environment),
    },
    hubspot: {
      clientId: required(environment, "HUBSPOT_CLIENT_ID"),
      clientSecret: required(environment, "HUBSPOT_CLIENT_SECRET"),
      publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
      supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
      publishableKey,
    },
    slack: slackClientId && slackClientSecret
      ? {
          clientId: slackClientId,
          clientSecret: slackClientSecret,
          publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ""),
          supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
          publishableKey,
        }
      : null,
    trigger: {
      apiUrl: secureUrl(
        environment.TRIGGER_API_URL?.trim() || "https://api.trigger.dev",
        "TRIGGER_API_URL",
      )
        .toString()
        .replace(/\/$/, ""),
      secretKey: required(environment, "TRIGGER_SECRET_KEY"),
    },
  };
}
