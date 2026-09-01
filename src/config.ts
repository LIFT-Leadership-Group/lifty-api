import type { SupabaseEnv } from "@supabase/server";

import type { SupabaseAuthenticationConfig } from "./supabase-auth.js";
import type { HubspotConnectSettings } from "./hubspot-connect.js";

type Environment = Record<string, string | undefined>;

export interface ServiceConfig {
  host: string;
  port: number;
  supabase: SupabaseAuthenticationConfig;
  hubspot: Omit<HubspotConnectSettings, "fetchImpl">;
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

  return {
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
