import { describe, expect, it, vi } from "vitest";

import * as oauth from "../src/hubspot-oauth.js";

const REQUIRED_SCOPES = [
  "oauth",
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.companies.read",
  "crm.objects.companies.write",
  "crm.schemas.contacts.read",
  "crm.schemas.companies.read",
];

describe("HubSpot OAuth mechanics", () => {
  it("builds consent for the one LIFTY app, callback, exact scopes, and opaque state", () => {
    const state = "a".repeat(64);
    const url = new URL(oauth.buildAuthorizationUrl({
      clientId: "client-123",
      redirectUri: "https://api.lifty.test/hubspot/callback",
      state,
    }));

    expect(url.origin + url.pathname).toBe(
      "https://app.hubspot.com/oauth/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.lifty.test/hubspot/callback",
    );
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(REQUIRED_SCOPES);
  });

  it("posts an authorization code in a form body and returns a normalized grant", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_in: 1800,
        scopes: [...REQUIRED_SCOPES].reverse(),
        hub_id: 49072478,
        hub_domain: "example.test",
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const fetchImpl = fetchSpy as typeof fetch;

    const grant = await oauth.exchangeAuthorizationCode({
      clientId: "client-123",
      clientSecret: "client-secret",
      redirectUri: "https://api.lifty.test/hubspot/callback",
      code: "authorization-code",
      fetchImpl,
    });

    expect(grant).toEqual({
      accessToken: "access-value",
      refreshToken: "refresh-value",
      expiresInSeconds: 1800,
      scopes: [...REQUIRED_SCOPES].sort(),
      hubId: "49072478",
      hubDomain: "example.test",
    });
    const request = fetchSpy.mock.calls[0];
    expect(String(request?.[0])).toBe("https://api.hubapi.com/oauth/2026-03/token");
    const body = new URLSearchParams(String(request?.[1]?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      client_id: "client-123",
      client_secret: "client-secret",
      redirect_uri: "https://api.lifty.test/hubspot/callback",
      code: "authorization-code",
    });
  });

  it("provides an exact-scope validator so expanded grants cannot pass silently", () => {
    expect(oauth.scopeSetMatchesExactly(REQUIRED_SCOPES)).toBe(true);
    expect(oauth.scopeSetMatchesExactly(REQUIRED_SCOPES.slice(1))).toBe(false);
    expect(oauth.scopeSetMatchesExactly([
      ...REQUIRED_SCOPES,
      "crm.objects.deals.read",
    ])).toBe(false);
  });

  it("refreshes server-side and accepts a rotated refresh token", async () => {
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 1800,
        scopes: REQUIRED_SCOPES,
        hub_id: 49072478,
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const fetchImpl = fetchSpy as typeof fetch;

    const grant = await oauth.refreshAccessToken({
      clientId: "client-123",
      clientSecret: "client-secret",
      refreshToken: "initial-refresh",
      fetchImpl,
    });

    expect(grant.accessToken).toBe("rotated-access");
    expect(grant.refreshToken).toBe("rotated-refresh");
    const body = new URLSearchParams(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: "client-123",
      client_secret: "client-secret",
      refresh_token: "initial-refresh",
    });
  });

  it("does not copy provider response bodies into refresh errors", async () => {
    const privateMarker = "provider-response-private-marker";
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: privateMarker }), { status: 401 })) as unknown as typeof fetch;

    await expect(oauth.refreshAccessToken({
      clientId: "client-123",
      clientSecret: "client-secret",
      refreshToken: "invalid-refresh",
      fetchImpl,
    })).rejects.not.toThrow(privateMarker);
  });
});
