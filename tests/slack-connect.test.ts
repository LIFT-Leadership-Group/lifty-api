import { describe, expect, it, vi } from "vitest";

import type { AuthSession } from "../src/app.js";
import {
  SlackCallbackError,
  createSlackConnectOperations,
} from "../src/slack-connect.js";
import { openSlackConnectIntent, sealSlackConnectIntent } from "../src/slack-state.js";

const SETTINGS = {
  clientId: "slack-client-123",
  clientSecret: "slack-client-secret",
  publicBaseUrl: "https://api.lifty.test/",
  supabaseUrl: "https://project.supabase.test",
  publishableKey: "sb_publishable_test",
};

function sessionWithRpc(implementation: (name: string) => Promise<{
  data: unknown;
  error: unknown;
}>): AuthSession {
  return { userId: "founder-123", client: { rpc: implementation } };
}

describe("hosted Slack connection operations", () => {
  it("mints a one-time connect capability with the founder-scoped RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { intent_token: "a".repeat(64), expires_in_seconds: 600 },
      error: null,
    }));
    const operations = createSlackConnectOperations({
      ...SETTINGS,
      fetchImpl: vi.fn() as typeof fetch,
    });

    const result = await operations.startConnect(sessionWithRpc(rpc));
    const state = new URL(result.connect_url).searchParams.get("intent") ?? "";

    expect(result).toMatchObject({ provider: "slack", expires_in_seconds: 600 });
    expect(openSlackConnectIntent(state, SETTINGS.clientSecret)).toBe("a".repeat(64));
    expect(rpc).toHaveBeenCalledWith("create_lifty_slack_connect_intent");
  });

  it("verifies OAuth and stores only the bot token through the capability RPC", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "groups:read,chat:write,channels:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
          enterprise: { id: "E123ORG", name: "Example Org" },
        });
      }
      if (url.endsWith("auth.test")) {
        return Response.json({
          ok: true,
          team_id: "T123TEAM",
          user_id: "U123BOT",
          bot_id: "B123BOT",
        });
      }
      if (url.endsWith("complete_lifty_slack_connection")) {
        return Response.json({ provider: "slack", status: "connected" });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    await expect(operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("b".repeat(64), SETTINGS.clientSecret),
    })).resolves.toEqual({ teamId: "T123TEAM", teamName: "Example" });

    expect(requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/oauth.v2.access",
      "https://slack.com/api/auth.test",
      "https://project.supabase.test/rest/v1/rpc/complete_lifty_slack_connection",
    ]);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      p_intent_token: "b".repeat(64),
      p_team_id: "T123TEAM",
      p_team_name: "Example",
      p_enterprise_id: "E123ORG",
      p_bot_user_id: "U123BOT",
      p_scopes: ["channels:read", "chat:write", "groups:read"],
      p_bot_token: "xoxb-installed-token",
    });
  });

  it("maps replayed state to a safe callback error", async () => {
    const marker = "provider-private-marker";
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: "xoxb-installed-token",
          token_type: "bot",
          scope: "channels:read,chat:write,groups:read",
          bot_user_id: "U123BOT",
          team: { id: "T123TEAM", name: "Example" },
        });
      }
      if (url.endsWith("auth.test")) {
        return Response.json({
          ok: true,
          team_id: "T123TEAM",
          user_id: "U123BOT",
          bot_id: "B123BOT",
        });
      }
      return Response.json({ message: `lifty_connect_intent_replayed ${marker}` }, { status: 409 });
    }) as typeof fetch;
    const operations = createSlackConnectOperations({ ...SETTINGS, fetchImpl });

    const error = await operations.completeCallback({
      code: "authorization-code",
      state: sealSlackConnectIntent("c".repeat(64), SETTINGS.clientSecret),
    }).catch((caught) => caught as SlackCallbackError);

    expect(error).toMatchObject({ reason: "link_used", status: 409 });
    expect(JSON.stringify(error)).not.toContain(marker);
  });
});
