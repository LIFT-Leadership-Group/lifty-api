import { describe, expect, it } from "vitest";

import {
  isSealedSlackState,
  openSlackConnectIntent,
  sealSlackConnectIntent,
} from "../src/slack-state.js";

describe("Slack connect state sealing", () => {
  it("round-trips the capability without exposing it", () => {
    const intent = "a".repeat(64);
    const sealed = sealSlackConnectIntent(intent, "client-secret");

    expect(isSealedSlackState(sealed)).toBe(true);
    expect(sealed).not.toContain(intent);
    expect(openSlackConnectIntent(sealed, "client-secret")).toBe(intent);
  });

  it("fails closed for tampering, another secret, and raw capabilities", () => {
    const sealed = sealSlackConnectIntent("b".repeat(64), "client-secret");
    const middle = Math.floor(sealed.length / 2);
    const tampered = `${sealed.slice(0, middle)}${sealed[middle] === "A" ? "B" : "A"}${sealed.slice(middle + 1)}`;

    expect(() => openSlackConnectIntent(tampered, "client-secret")).toThrow(
      "invalid_slack_state",
    );
    expect(() => openSlackConnectIntent(sealed, "another-secret")).toThrow(
      "invalid_slack_state",
    );
    expect(isSealedSlackState("b".repeat(64))).toBe(false);
  });
});
