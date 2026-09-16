import type { SupabaseEnv } from "@supabase/server";
import { createContextClient, verifyAuth } from "@supabase/server/core";

import type { AuthenticationResult } from "./app.js";

export function createTimeoutFetch(
  fetchImplementation: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input, init) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const callerSignal = init?.signal
      ?? (input instanceof Request ? input.signal : null);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    return fetchImplementation(input, { ...init, signal });
  };
}

export interface SupabaseAuthenticationConfig {
  supabaseUrl: string;
  publishableKey: string;
  jwks: Exclude<SupabaseEnv["jwks"], null>;
}

export interface SupabaseAuthenticatorOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createSupabaseReadinessCheck(
  config: SupabaseAuthenticationConfig,
  options: SupabaseAuthenticatorOptions = {},
): () => Promise<boolean> {
  const timeoutFetch = createTimeoutFetch(
    options.fetch ?? globalThis.fetch.bind(globalThis),
    // Stay under the App Platform probe timeout (2s) so an unreachable
    // Supabase reports unready instead of timing out the probe itself.
    options.timeoutMs ?? 1_500,
  );
  const healthUrl = new URL("/auth/v1/health", config.supabaseUrl).toString();
  return async () => {
    try {
      const response = await timeoutFetch(healthUrl, {
        headers: { apikey: config.publishableKey },
      });
      return response.ok;
    } catch {
      return false;
    }
  };
}

export function createSupabaseAuthenticator(
  config: SupabaseAuthenticationConfig,
  options: SupabaseAuthenticatorOptions = {},
): (request: Request) => Promise<AuthenticationResult> {
  const timeoutFetch = createTimeoutFetch(
    options.fetch ?? globalThis.fetch.bind(globalThis),
    options.timeoutMs ?? 10_000,
  );
  const env: SupabaseEnv = {
    url: config.supabaseUrl,
    publishableKeys: { default: config.publishableKey },
    secretKeys: {},
    jwks: config.jwks,
  };

  return async (request) => {
    const { data, error } = await verifyAuth(request, {
      auth: "user",
      env,
    });
    if (error || !data.userClaims) {
      return { ok: false, reason: "invalid_session" };
    }
    const claims = data.jwtClaims;
    const expectedIssuer = new URL("/auth/v1", config.supabaseUrl).toString();
    if (!claims || claims.role !== "authenticated"
      || claims.iss !== expectedIssuer
      || !(claims.aud === "authenticated"
        || (Array.isArray(claims.aud) && claims.aud.includes("authenticated")))) {
      return { ok: false, reason: "invalid_session" };
    }
    const client = createContextClient({
      auth: { token: data.token, keyName: data.keyName ?? null },
      env,
      supabaseOptions: { global: { fetch: timeoutFetch } },
    });
    // Signature/expiry validation cannot detect logout or server-side session
    // revocation. Query only the caller's session through the RLS-scoped client
    // before any handler runs; never cache an affirmative session result.
    try {
      const { data: active, error: sessionError } = await client.rpc("lifty_session_active");
      if (sessionError || active !== true) {
        return { ok: false, reason: "invalid_session" };
      }
    } catch {
      return { ok: false, reason: "invalid_session" };
    }
    return {
      ok: true,
      session: {
        userId: data.userClaims.id,
        client,
      },
    };
  };
}
