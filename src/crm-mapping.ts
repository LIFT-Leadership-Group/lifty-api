import { z } from "zod";
import { PublicError } from "./errors.js";
import { CrmRecordsSchema } from "./crm-records.js";
import { runCrmMapping, type CrmMappingSettings } from "./crm-mapping/runtime.js";
import {
  MappingError, CrmMappingCatalogSchema, CrmMappingSourcesSchema,
  CrmMappingPreviewSchema, CrmMappingApplySchema, CrmMappingPropertyCreateSchema,
  CrmMappingSyncSchema, CrmMappingStatusSchema, type CrmMappingAction, type CrmMappingOperation,
} from "./crm-mapping/contracts.js";

const IssueSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/),
  path: z.string().max(300), message: z.string().max(600), suggestion: z.string().max(1000),
});
const ErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/);
const ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429, 502, 503, 504]);
const responses: Record<CrmMappingAction, z.ZodType> = {
  catalog: CrmMappingCatalogSchema, sources: CrmMappingSourcesSchema, preview: CrmMappingPreviewSchema,
  apply: CrmMappingApplySchema, property_create: CrmMappingPropertyCreateSchema,
  sync: CrmMappingSyncSchema, status: CrmMappingStatusSchema, records: CrmRecordsSchema,
};

export class CrmMappingError extends PublicError {
  constructor(code: string, status: number, readonly issues: z.infer<typeof IssueSchema>[] = []) {
    super({ code, status, message: "CRM mapping could not be verified. Read the current catalog or exact run status and follow the reported repair details." });
  }
}

/** Keep native workflow failures bounded at the public API boundary. */
export function createCrmMapping(settings: CrmMappingSettings | null): CrmMappingOperation {
  return async (session, action, input, options) => {
    if (!settings) throw new CrmMappingError("CRM_MAPPING_NOT_CONFIGURED", 503);
    try {
      const raw = await runCrmMapping(session, settings, action, input, options);
      const parsed = responses[action].safeParse(raw);
      if (!parsed.success) throw new CrmMappingError("INVALID_CRM_MAPPING_RESPONSE", 502);
      return parsed.data;
    } catch (error) {
      if (error instanceof CrmMappingError) throw error;
      if (error instanceof MappingError && ErrorCodeSchema.safeParse(error.code).success && ERROR_STATUSES.has(error.status)) {
        const issues = z.array(IssueSchema).max(20).safeParse(error.issues);
        throw new CrmMappingError(error.code, error.status, issues.success ? issues.data : []);
      }
      throw new CrmMappingError("CRM_MAPPING_UNAVAILABLE", 502);
    }
  };
}
