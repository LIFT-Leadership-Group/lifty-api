import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

// Same bounded HTTP(S) syntax as the database; URLs are data, never fetched here.
export const BusinessWebsiteUrl = z.string().max(2048).regex(/^https?:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?([/?#][^\s\x00-\x1f\x7f]*)?$/);
export const BusinessWebsiteSchema = z.object({
  workspace_ref: z.uuid(), version: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  website_url: BusinessWebsiteUrl.nullable(),
  candidates: z.array(z.object({ url: BusinessWebsiteUrl, source: z.literal("saved_onboarding_research"), confirmed: z.literal(false) }).strict()).max(10),
}).strict();
export const BusinessWebsitePatchSchema = z.object({ section: z.literal("website"),
  expected_version: BusinessWebsiteSchema.shape.version,
  values: z.object({ website_url: BusinessWebsiteUrl.nullable() }).strict(),
}).strict();
export type BusinessWebsite = z.infer<typeof BusinessWebsiteSchema>;
export type BusinessWebsitePatch = z.infer<typeof BusinessWebsitePatchSchema>;
const RpcWebsite = BusinessWebsiteSchema.omit({ candidates: true }).extend({ candidate_sources: z.array(z.string().max(2048)).max(20) }).strict();

export function projectWebsite(input: unknown): BusinessWebsite {
  const { candidate_sources, ...profile } = RpcWebsite.parse(input);
  const candidates = new Set<string>();
  for (const source of candidate_sources) {
    for (const match of source.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      const raw = match[0].replace(/[.,;)\]]+$/, "");
      if (!BusinessWebsiteUrl.safeParse(raw).success) continue;
      try {
        const url = new URL(raw);
        if (url.username || url.password) continue;
        candidates.add(url.href);
      } catch { /* malformed research citations are not website choices */ }
    }
  }
  return BusinessWebsiteSchema.parse({ ...profile, candidates: [...candidates].slice(0, 10).map(url => ({ url, source: "saved_onboarding_research", confirmed: false })) });
}
async function websiteRpc(session: AuthSession, name: string, args?: Record<string, unknown>): Promise<BusinessWebsite> {
  const client = session.client as { rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> };
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const message = (error as { message?: string }).message ?? "";
    const code = (error as { code?: string }).code;
    if (message === "lifty_website_stale") throw new PublicError({ status: 409, code: "BUSINESS_WEBSITE_STALE", message: "The saved website changed. Read the business profile before retrying." });
    if (code === "PT401" || code === "PT403" || code === "PT409") throw new PublicError({ status: code === "PT401" ? 401 : code === "PT403" ? 403 : 409, code: "WORKSPACE_UNAVAILABLE", message: "The current workspace could not be verified. Refresh workspace status." });
    if (code === "PT400") throw new PublicError({ status: 400, code: "BUSINESS_WEBSITE_INVALID", message: "Use the current business website schema." });
    throw new PublicError({ status: 502, code: "BUSINESS_WEBSITE_UNAVAILABLE", message: "The saved website could not be read or updated. Retry the read before changing it." });
  }
  try { return projectWebsite(data); } catch (cause) {
    throw new PublicError({ status: 502, code: "BUSINESS_WEBSITE_UNAVAILABLE", message: "The saved website could not be verified.", cause });
  }
}
export const getBusinessWebsite = (session: AuthSession) => websiteRpc(session, "get_lifty_business_website");
export const setBusinessWebsite = (session: AuthSession, input: BusinessWebsitePatch) => websiteRpc(session, "set_lifty_business_website", { payload: { ...input.values, expected_version: input.expected_version } });
