import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createSupabaseAuthenticator } from "../src/supabase-auth.js";

describe("documented REST authentication surface", () => {
  it("rejects absent, malformed and expired JWTs at every protected operation before upstream work", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "route-matrix", alg: "ES256" }] };
    const expired = await new SignJWT({ role: "authenticated", session_id: "62710000-0000-4000-a000-000000000011" })
      .setSubject("62710000-0000-4000-a000-000000000001")
      .setProtectedHeader({ alg: "ES256", kid: "route-matrix" })
      .setIssuer("https://project.supabase.test/auth/v1").setAudience("authenticated")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(privateKey);
    const upstream = vi.fn<typeof fetch>(async () => { throw new Error("unexpected upstream work"); });
    const authenticate = createSupabaseAuthenticator({
      supabaseUrl: "https://project.supabase.test", publishableKey: "sb_publishable_route_matrix", jwks,
    }, { fetch: upstream });
    const logs = vi.fn();
    const app = createApp({ authenticate, log: logs });
    const contract = await (await app.request("/openapi.json")).json() as {
      paths: Record<string, Record<string, { security?: Array<Record<string, unknown>> }>>;
    };
    let operations = 0;
    for (const [path, methods] of Object.entries(contract.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!operation.security?.some(requirement => "bearerAuth" in requirement)) continue;
        operations++;
        for (const token of [null, "malformed.jwt.token", expired]) {
          const response = await app.request(path.replace(/\{[^}]+\}/g, "62710000-0000-4000-a000-000000000011"), {
            method: method.toUpperCase(),
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            ...(["get", "head"].includes(method) ? {} : { body: JSON.stringify({ private_marker: "DO_NOT_ECHO" }) }),
          });
          expect(response.status, `${method} ${path}`).toBe(401);
          expect(await response.text()).not.toContain("DO_NOT_ECHO");
        }
      }
    }
    expect(operations).toBeGreaterThan(30);
    expect(upstream).not.toHaveBeenCalled();
    expect(JSON.stringify(logs.mock.calls)).not.toContain(expired);
    expect(JSON.stringify(logs.mock.calls)).not.toContain("DO_NOT_ECHO");
  });
});
