import { describe, expect, it, vi } from "vitest";

import * as oauth from "../src/slack-oauth.js";

describe("Slack OAuth mechanics", () => {
  it("builds consent with the exact outbound-only scopes", () => {
    const state = "a".repeat(96);
    const url = new URL(oauth.buildSlackAuthorizationUrl({
      clientId: "slack-client-123",
      redirectUri: "https://api.lifty.test/slack/callback",
      state,
    }));

    expect(url.origin + url.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(url.searchParams.get("client_id")).toBe("slack-client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.lifty.test/slack/callback",
    );
    expect(url.searchParams.get("state")).toBe(state);
    expect(url.searchParams.get("scope")?.split(",").sort()).toEqual([
      "channels:read",
      "chat:write",
      "groups:read",
    ]);
    expect(url.searchParams.get("scope")).not.toMatch(
      /chat:write\.public|history|incoming-webhook/,
    );
  });

  it("exchanges the code and verifies the installed bot identity", async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://slack.com/api/oauth.v2.access") {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "groups:read,chat:write,channels:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
          enterprise: null,
        });
      }
      if (url === "https://slack.com/api/auth.test") {
        return Response.json({
          ok: true,
          team_id: "T123TEAM",
          user_id: "U123BOT",
          bot_id: "B123BOT",
        });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const fetchImpl = fetchSpy as typeof fetch;

    const grant = await oauth.exchangeAndVerifySlackGrant({
      clientId: "slack-client-123",
      clientSecret: "slack-client-secret",
      redirectUri: "https://api.lifty.test/slack/callback",
      code: "authorization-code",
      fetchImpl,
    });

    expect(grant).toEqual({
      accessToken: "xoxb-installed-token",
      botUserId: "U123BOT",
      enterpriseId: null,
      scopes: ["channels:read", "chat:write", "groups:read"],
      teamId: "T123TEAM",
      teamName: "Example",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: { authorization: "Bearer xoxb-installed-token" },
    });
  });

  it("rejects expanded scopes and a mismatched bot identity", async () => {
    const expanded = vi.fn(async () => Response.json({
      ok: true,
      access_token: "xoxb-installed-token",
      token_type: "bot",
      scope: "channels:read,chat:write,groups:read,channels:history",
      bot_user_id: "U123BOT",
      team: { id: "T123TEAM", name: "Example" },
    })) as typeof fetch;

    await expect(oauth.exchangeAndVerifySlackGrant({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://api.lifty.test/slack/callback",
      code: "code",
      fetchImpl: expanded,
    })).rejects.toThrow("slack_scope_mismatch");
    expect(expanded).toHaveBeenCalledOnce();

    const mismatched = vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith("oauth.v2.access")
        ? Response.json({
            ok: true,
            access_token: "xoxb-installed-token",
            token_type: "bot",
            scope: "channels:read,chat:write,groups:read",
            bot_user_id: "U123BOT",
            team: { id: "T123TEAM", name: "Example" },
          })
        : Response.json({
            ok: true,
            team_id: "TOTHER",
            user_id: "U123BOT",
            bot_id: "B123BOT",
          })) as typeof fetch;

    await expect(oauth.exchangeAndVerifySlackGrant({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://api.lifty.test/slack/callback",
      code: "code",
      fetchImpl: mismatched,
    })).rejects.toThrow("slack_identity_mismatch");
  });

  it("does not copy Slack response bodies into errors", async () => {
    const marker = "provider-private-marker";
    const fetchImpl = vi.fn(async () => Response.json({
      ok: false,
      error: marker,
    })) as typeof fetch;

    await expect(oauth.exchangeAndVerifySlackGrant({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://api.lifty.test/slack/callback",
      code: "code",
      fetchImpl,
    })).rejects.not.toThrow(marker);
  });
});
