import type { SupabaseEnv } from "@supabase/server";
import { createContextClient, verifyAuth } from "@supabase/server/core";

import type { AuthenticationResult } from "./app.js";

export interface SupabaseAuthenticationConfig {
  supabaseUrl: string;
  publishableKey: string;
  jwks: Exclude<SupabaseEnv["jwks"], null>;
}

export function createSupabaseAuthenticator(
  config: SupabaseAuthenticationConfig,
): (request: Request) => Promise<AuthenticationResult> {
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
        }),
      },
    };
  };
}
