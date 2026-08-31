import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import {
  createSupabaseAuthenticator,
  createSupabaseReadinessCheck,
  createTimeoutFetch,
} from "../src/supabase-auth.js";

async function jwtFixture(expiration: string | number | Date = "5m") {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(publicKey);
  const kid = "lifty-test-key";
  const signToken = async (expiresAt: string | number | Date) =>
    new SignJWT({
      email: "founder@example.com",
      role: "authenticated",
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject("founder-123")
      .setAudience("authenticated")
      .setIssuer("https://project.supabase.test/auth/v1")
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(privateKey);
  const token = await signToken(expiration);

  return {
    token,
    jwks: {
      keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }],
    },
    signToken,
  };
}

describe("Supabase authentication boundary", () => {
  it("aborts an upstream request when the Supabase deadline expires", async () => {
    const hangingFetch: typeof fetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      });

    await expect(
      createTimeoutFetch(hangingFetch, 5)("https://project.supabase.test/rest/v1/rpc/test"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("verifies a user JWT and exposes only the RLS-scoped client", async () => {
    const { token, jwks } = await jwtFixture();
    const authenticate = createSupabaseAuthenticator({
      supabaseUrl: "https://project.supabase.test",
      publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      jwks,
    });

    const result = await authenticate(
      new Request("https://api.lifty.test/v1/workspace", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected authenticated session");
    expect(result.session.userId).toBe("founder-123");
    expect(Object.keys(result.session).sort()).toEqual(["client", "userId"]);
    expect(result.session.client).toBeDefined();
  });

  it("uses the timeout fetch for request-scoped Supabase calls", async () => {
    const { token, jwks } = await jwtFixture();
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const upstreamFetch: typeof fetch = async (_input, init) => {
      observedSignal.current = init?.signal ?? null;
      return new Response(JSON.stringify({ state: "needs_workspace" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const authenticate = createSupabaseAuthenticator(
      {
        supabaseUrl: "https://project.supabase.test",
        publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
        jwks,
      },
      { fetch: upstreamFetch, timeoutMs: 50 },
    );

    const result = await authenticate(
      new Request("https://api.lifty.test/v1/workspace", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (!result.ok) throw new Error("expected authenticated session");
    const rpcResult = await (result.session.client as {
      rpc(name: string): Promise<{ data: unknown; error: unknown }>;
    }).rpc("get_lifty_workspace_status");

    expect(rpcResult.error).toBeNull();
    expect(observedSignal.current).toBeInstanceOf(AbortSignal);
    expect(observedSignal.current?.aborted).toBe(false);
  });

  it("fails closed with one generic result for missing, malformed, and expired JWTs", async () => {
    const { jwks, signToken } = await jwtFixture();
    const expiredToken = await signToken(
      Math.floor(Date.now() / 1000) - 60,
    );
    const authenticate = createSupabaseAuthenticator({
      supabaseUrl: "https://project.supabase.test",
      publishableKey: "sb_publishable_test_abcdefghijklmnopqrstuvwxyz",
      jwks,
    });

    const requests = [
      new Request("https://api.lifty.test/v1/workspace"),
      new Request("https://api.lifty.test/v1/workspace", {
        headers: { authorization: "Bearer malformed.jwt.token" },
      }),
      new Request("https://api.lifty.test/v1/workspace", {
        headers: { authorization: `Bearer ${expiredToken}` },
      }),
    ];

    for (const request of requests) {
      await expect(authenticate(request)).resolves.toEqual({
        ok: false,
        reason: "invalid_session",
      });
    }
  });
});

describe("Supabase readiness check", () => {
  const config = {
    supabaseUrl: "https://project.supabase.test",
    publishableKey: "sb_publishable_test",
    jwks: { keys: [] },
  };

  it("probes the auth health endpoint with the publishable key", async () => {
    const calls: Array<{ url: string; apikey: string | undefined }> = [];
    const okFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), apikey: headers.get("apikey") ?? undefined });
      return new Response("{}", { status: 200 });
    };

    const check = createSupabaseReadinessCheck(config, { fetch: okFetch });

    await expect(check()).resolves.toBe(true);
    expect(calls).toEqual([{
      url: "https://project.supabase.test/auth/v1/health",
      apikey: "sb_publishable_test",
    }]);
  });

  it("reports unready on a non-2xx upstream response", async () => {
    const failingFetch: typeof fetch = async () =>
      new Response("{}", { status: 503 });

    const check = createSupabaseReadinessCheck(config, { fetch: failingFetch });

    await expect(check()).resolves.toBe(false);
  });

  it("reports unready when the probe cannot reach Supabase", async () => {
    const unreachableFetch: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const check = createSupabaseReadinessCheck(config, { fetch: unreachableFetch });

    await expect(check()).resolves.toBe(false);
  });

  it("reports unready when the probe exceeds its deadline", async () => {
    const hangingFetch: typeof fetch = async (_input, init) =>
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      });

    const check = createSupabaseReadinessCheck(config, {
      fetch: hangingFetch,
      timeoutMs: 20,
    });

    await expect(check()).resolves.toBe(false);
  });
});
