import { z } from "zod";
import { EmailCampaignPreview, EmailPlacementPreview, EmailPlacementResult } from "./email-campaign-contracts.js";
import { LinkedinCampaignResult } from "./linkedin-campaign-contracts.js";
import { PublicError } from "./errors.js";

// Historical safety/read receipts only. Native services retain their original
// delivery evidence; customer HTTP never exposes a delivery vendor or its IDs.
const vendor = /apollo|unipile|smartlead|heyreach|mailivery|smartdelivery/i;
const code = (value: string | null, fallback: string) => value && vendor.test(value) ? fallback : value;
export const HistoricalEmailPreviewSchema = EmailCampaignPreview.extend({ content: EmailCampaignPreview.shape.content.omit({ provider: true }).strict() }).strict();
export const HistoricalEmailResultSchema = z.union([HistoricalEmailPreviewSchema, EmailPlacementPreview, EmailPlacementResult,
  z.object({ suppressed: z.literal(true), lead_ref: z.uuid() }).strict()]);
export const HistoricalLinkedinResultSchema = LinkedinCampaignResult.extend({
  actions: z.array(LinkedinCampaignResult.shape.actions.element.omit({ provider_id: true, chat_id: true }).strict()).max(4),
}).strict();
export function historicalEmailResult(value: unknown) {
  if (value && typeof value === "object" && "content" in value) {
    const native = EmailCampaignPreview.parse(value);
    const { provider: _provider, ...content } = native.content;
    return HistoricalEmailPreviewSchema.parse({ ...native, content,
      blockers: native.blockers.map(value => code(value, "email_delivery_unavailable")) });
  }
  return HistoricalEmailResultSchema.parse(value);
}
export function historicalLinkedinResult(value: unknown) {
  const native = LinkedinCampaignResult.parse(value);
  return HistoricalLinkedinResultSchema.parse({ ...native,
    actions: native.actions.map(({ provider_id: _provider, chat_id: _chat, ...action }) => ({ ...action, error_code: code(action.error_code, "delivery_unavailable") })),
    blockers: native.blockers.map(value => code(value, "delivery_unavailable")),
  });
}
export async function historicalOperation<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof PublicError && (vendor.test(error.code + error.message) || error.code === "EMAIL_PROVIDER_NOT_SELECTED"))
      throw new PublicError({ status: error.status, code: "SENDING_ACCOUNT_UNAVAILABLE", message: "The sending account could not be verified. Read its connection and recovery status before continuing.", cause: error });
    throw error;
  }
}
