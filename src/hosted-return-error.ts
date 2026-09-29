import { z } from "zod";

/**
 * Safe categories for an error Unipile reports when it redirects a hosted
 * authorization back to Lifty. The browser value is an untrusted hint: it
 * explains an unfinished attempt and never binds, fails or supersedes one.
 */
export const HostedReturnError = z.enum(["authorization_cancelled", "account_exists", "provider_rejected"]);
export type HostedReturnError = z.infer<typeof HostedReturnError>;

/** Maps Unipile's `error_type` to a category; provider text is never kept. */
export function hostedReturnError(errorType: string | undefined): HostedReturnError | null {
  if (!errorType) return null;
  if (errorType === "canceled" || errorType === "consent_denied") return "authorization_cancelled";
  if (errorType === "api/already_exists") return "account_exists";
  return "provider_rejected";
}

/** The return page's reason for each category. */
export const hostedReturnReason = {
  authorization_cancelled: "canceled", account_exists: "exists", provider_rejected: "provider",
} as const satisfies Record<HostedReturnError, string>;
