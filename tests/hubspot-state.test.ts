import { describe, expect, it } from "vitest";

import {
  isSealedHubspotState,
  openHubspotConnectIntent,
  sealHubspotConnectIntent,
} from "../src/hubspot-state.js";

describe("HubSpot connect state sealing", () => {
  it("round-trips the database capability without exposing it", () => {
    const intent = "a".repeat(64);
    const sealed = sealHubspotConnectIntent(intent, "client-secret");

    expect(isSealedHubspotState(sealed)).toBe(true);
    expect(sealed).not.toContain(intent);
    expect(openHubspotConnectIntent(sealed, "client-secret")).toBe(intent);
  });

  it("fails closed for tampering, another secret, and raw capabilities", () => {
    const sealed = sealHubspotConnectIntent("b".repeat(64), "client-secret");
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;

    expect(() => openHubspotConnectIntent(tampered, "client-secret")).toThrow(
      "invalid_hubspot_state",
    );
    expect(() => openHubspotConnectIntent(sealed, "another-secret")).toThrow(
      "invalid_hubspot_state",
    );
    expect(isSealedHubspotState("b".repeat(64))).toBe(false);
  });
});
