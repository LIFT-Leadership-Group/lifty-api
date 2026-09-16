import { MappingError } from "./company-mapping/contract.js";
import { runCompanyMapping, type CompanyMappingSettings, type CompanyMappingOptions } from "./company-mapping/runtime.js";
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
  mapping_count: z.number().int().positive(),
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
export function createCompanyMapping(settings: CompanyMappingSettings | null) {
  return async function companyMapping(
    session: AuthSession, action: "context" | "apply", plan?: unknown,
    options: CompanyMappingOptions = {},
  ) {
    if (!settings) throw new CompanyMappingError("COMPANY_MAPPING_NOT_CONFIGURED", 503);
    try {
      const raw = await runCompanyMapping(session, settings, action, plan, options);
      const parsed = (action === "context" ? CompanyMappingContextSchema : CompanyMappingReceiptSchema).safeParse(raw);
      if (!parsed.success) throw new CompanyMappingError("INVALID_COMPANY_MAPPING_RESPONSE", 502);
      return parsed.data;
    } catch (error) {
      if (error instanceof CompanyMappingError) throw error;
      if (error instanceof MappingError) {
        const issues = z.array(Issue).max(20).safeParse(error.issues);
        throw new CompanyMappingError(error.code, error.status, issues.success ? issues.data : []);
      }
      throw new CompanyMappingError("COMPANY_MAPPING_UNAVAILABLE", 502);
    }
  };
}
export type CompanyMappingOperation = ReturnType<typeof createCompanyMapping>;
