import { z } from "zod";
import type { SupabaseAuthenticationConfig } from "../supabase-auth.js";
import type { CrmMappingSettings } from "./runtime.js";

/** Static capability probe: no tenant identity, stored grant or provider read. */
export function createCrmMappingReadinessCheck(
  supabase: SupabaseAuthenticationConfig, settings: CrmMappingSettings | null,
): () => Promise<boolean> {
  return async () => {
    if (!settings) return false;
    try {
      const response = await (settings.fetch ?? fetch)(`${supabase.supabaseUrl}/rest/v1/rpc/lifty_crm_mapping_tools`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(1500),
        headers: { apikey: supabase.publishableKey, "content-type": "application/json" },
        body: JSON.stringify({ p_server_key: settings.serverKey, p_operation: "capabilities", p_payload: {} }),
      });
      return response.ok && z.object({ version: z.literal("lifty-crm-mapping.v1"), ready: z.literal(true) }).safeParse(await response.json()).success;
    } catch { return false; }
  };
}
