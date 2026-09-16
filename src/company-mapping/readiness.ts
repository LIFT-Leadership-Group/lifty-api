import { z } from "zod";
import type { SupabaseAuthenticationConfig } from "../supabase-auth.js";
import type { CompanyMappingSettings } from "./runtime.js";

/** Static capability probe: no tenant identity, Vault read, or provider mutation. */
export function createCompanyReadinessCheck(
  supabase: SupabaseAuthenticationConfig, settings: CompanyMappingSettings | null,
): () => Promise<boolean> {
  return async () => {
    if (!settings) return false;
    try {
      const response = await (settings.fetch ?? fetch)(`${supabase.supabaseUrl}/rest/v1/rpc/lifty_crm_company_tools`, {
        method: "POST", signal: AbortSignal.timeout(1500),
        headers: { apikey: supabase.publishableKey, "content-type": "application/json" },
        body: JSON.stringify({ p_server_key: settings.serverKey, p_operation: "capabilities", p_payload: {} }),
      });
      return response.ok && z.object({ version: z.literal("lifty-crm-company.v1"), ready: z.literal(true) }).safeParse(await response.json()).success;
    } catch { return false; }
  };
}
