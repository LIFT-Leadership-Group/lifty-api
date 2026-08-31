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
    return {
      ok: true,
      session: {
        userId: data.userClaims.id,
        client: createContextClient({
          auth: { token: data.token, keyName: data.keyName ?? null },
          env,
          supabaseOptions: { global: { fetch: timeoutFetch } },
        }),
      },
    };
  };
}
