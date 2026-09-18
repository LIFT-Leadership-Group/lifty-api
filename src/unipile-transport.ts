import { z } from "zod";

export const ProviderIdentifier = z.string().regex(/^[A-Za-z0-9_-]{1,255}$/);
/** Only database-returned bindings may select a provider transport. Never parse browser data with this schema. */
export const UnipileTransport = z.object({
  api_version: z.enum(["v1", "v2"]), connection_ref: z.uuid().nullable(),
  canonical_account_id: ProviderIdentifier.nullable(), provider_namespace: z.string().min(1),
  account_id: ProviderIdentifier.nullable(), application_id: ProviderIdentifier.nullable(),
  account_scope_id: ProviderIdentifier.nullable(), user_id: z.string().min(1).max(255).nullable(),
  // Older V1/Google snapshots predate this field. LinkedIn validates its presence separately.
  owner_profile_id: ProviderIdentifier.nullable().default(null),
  v1_account_id: ProviderIdentifier.nullable(), generation: z.number().int().nonnegative(),
  hosted_auth_origin: z.url(),
});
export type UnipileTransport = z.infer<typeof UnipileTransport>;
export const VerifiedTransport = z.object({
  api_version: z.literal("v2"), account_id: ProviderIdentifier, application_id: ProviderIdentifier,
  account_scope_id: ProviderIdentifier.nullable(), user_id: z.string().min(1).max(255),
  v1_account_id: ProviderIdentifier.nullable(), owner_profile_id: ProviderIdentifier.nullable(),
});
export type VerifiedTransport = z.infer<typeof VerifiedTransport>;
