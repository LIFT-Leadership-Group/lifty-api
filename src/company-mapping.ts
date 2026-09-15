import { z } from "zod";
import type { AuthSession } from "./app.js";
import { PublicError } from "./errors.js";

const Issue = z.object({
  code: z.string().max(100),
  path: z.string().max(300),
  message: z.string().max(600),
  suggestion: z.string().max(1000),
});
export const CompanyMappingContextSchema = z.object({
  version: z.literal(1),
  workspace_ref: z.uuid(),
  workspace_name: z.string(),
  portal_id: z.string().regex(/^\d+$/),
  integration_ref: z.uuid(),
  mapping_version: z.string().regex(/^[a-f0-9]{64}$/),
  schema_version: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(["ready", "action_needed"]),
  properties: z.array(z.record(z.string(), z.unknown())),
  mappings: z.array(z.record(z.string(), z.unknown())),
  configured_values: z.unknown(),
  issues: z.array(Issue).max(20),
  instructions: z.string().max(20000),
  input_schema: z.record(z.string(), z.unknown()),
});
export const CompanyMappingReceiptSchema = z.object({
  status: z.literal("ready"),
  workspace_ref: z.uuid(),
  portal_id: z.string().regex(/^\d+$/),
  mapping_count: z.literal(5),
  schema_changes: z.number().int().nonnegative(),
  verified: z.literal(true),
});
export class CompanyMappingError extends PublicError {
  readonly issues: z.infer<typeof Issue>[];
  constructor(
    code: string,
    status: number,
    issues: z.infer<typeof Issue>[] = [],
  ) {
    super({
      code,
      status,
      message:
        "Company configuration could not be verified. Fetch fresh company-mapping context and follow its repair instructions.",
    });
    this.issues = issues;
  }
}
interface EdgeClient {
  functions: {
    invoke(
      name: string,
      options: { body: unknown },
    ): Promise<{ data: unknown; error: unknown }>;
  };
}
const ErrorBody = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z_]{1,100}$/),
    issues: z.array(Issue).max(20).optional(),
  }),
});
export async function companyMapping(
  session: AuthSession,
  action: "context" | "apply",
  plan?: unknown,
) {
  const client = session.client as EdgeClient;
  const { data, error } = await client.functions.invoke(
    "lifty-company-mapping",
    { body: { action, ...(action === "apply" ? { plan } : {}) } },
  );
  if (error) {
    const response = (error as { context?: unknown }).context;
    if (response instanceof Response) {
      const body = ErrorBody.safeParse(await response.json().catch(() => null));
      if (body.success) {
        throw new CompanyMappingError(
          body.data.error.code,
          [400, 401, 403, 409, 413, 422, 429, 502, 503].includes(
              response.status,
            )
            ? response.status
            : 502,
          body.data.error.issues,
        );
      }
    }
    throw new CompanyMappingError("COMPANY_MAPPING_UNAVAILABLE", 502);
  }
  const envelope = data as { data?: unknown } | null;
  const result =
    (action === "context"
      ? CompanyMappingContextSchema
      : CompanyMappingReceiptSchema).safeParse(envelope?.data);
  if (!result.success) {
    throw new CompanyMappingError("INVALID_COMPANY_MAPPING_RESPONSE", 502);
  }
  return result.data;
}
