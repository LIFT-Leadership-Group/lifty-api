import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { createSupabaseAuthenticator } from "../src/supabase-auth.js";

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
