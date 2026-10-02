import { describe, expect, it } from "vitest";
import fixtures from "./outreach-sql-fixtures.json" with { type: "json" };
import { JourneyResultSchema, CampaignResultSchema, JourneysSchema, CampaignsSchema, CampaignActivationResultSchema } from "../src/outreach-contracts.js";

// Captured from real RPCs on the LIF-1188 scratch database, with artificial
// fixture identities. Protects SQL/API drift beyond synthetic HTTP mocks.
describe("canonical Outreach SQL receipts", () => {
  it.each([
    ["journey_detail", JourneyResultSchema], ["campaign_detail", CampaignResultSchema],
    ["journeys_list", JourneysSchema], ["campaigns_list", CampaignsSchema],
    ["campaign_activation", CampaignActivationResultSchema],
  ] as const)("parses %s", (key, schema) => {
    expect(schema.safeParse(fixtures[key])).toMatchObject({ success: true });
  });
});
