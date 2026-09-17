import { z } from "zod";
import type { AuthSession } from "../app.js";
export {
  MappingError,
  fingerprint,
  stableJson,
} from "../company-mapping/contract.js";
const Json = z.record(z.string(), z.unknown());
const Ref = z.uuid();
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ObjectSchema = z.enum(["contact", "company"]);
export const MappingValuesSchema = z
  .object({
    workspace_id: Ref,
    provider: z.literal("hubspot"),
    source_stage: z.enum(["discovery", "research", "outreach", "verification"]),
    source_entity: z.enum(["lead", "company"]),
    source_field: z.string().min(1).max(200),
    label: z.string().max(300).nullable(),
    source_path: z.array(z.string().min(1).max(200)).min(1).max(20),
    destination_object: ObjectSchema,
    destination_field: z.string().min(1).max(200),
    write_rule: z.enum([
      "create_only",
      "only_if_empty",
      "overwrite_lift_field",
      "managed_enum_transition",
    ]),
    transform: z.enum([
      "none",
      "bucket",
      "map_value",
      "join_list",
      "json_string",
      "scale_number",
      "normalize_domain",
    ]),
    transform_config: Json,
    value_source: z.enum([
      "path",
      "constant",
      "runtime",
      "counterpart_property",
    ]),
    enabled: z.boolean(),
    required_from_agent: z.boolean(),
    clay_path: z.array(z.string()).nullable(),
    comparison_rule: z
      .enum([
        "exact",
        "case_insensitive",
        "normalize_then_exact",
        "numeric_tolerance",
        "set_overlap",
      ])
      .nullable(),
    comparison_config: Json,
    fallback_group: z.string().nullable(),
    fallback_priority: z.number().int().nonnegative().nullable(),
    sort_order: z.number().int(),
  })
  .strict();
export const MappingSchema = MappingValuesSchema.extend({
  id: Ref,
  created_at: z.string(),
  updated_at: z.string(),
}).strip();
export const MappingEditSchema = MappingValuesSchema.extend({
  id: Ref.nullable(),
  expected_updated_at: z.string().nullable(),
});
export const ScopeSchema = z.object({
  workspace_ref: Ref,
  integration_ref: Ref,
  portal_id: z.string().regex(/^\d{1,30}$/),
  mapping_version: Digest,
});
export const StateSchema = ScopeSchema.extend({
  workspace_name: z.string(),
  allow_provisioning: z.boolean(),
  mappings: z.array(MappingSchema),
});
export type State = z.infer<typeof StateSchema>;
export const PropertySchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.string(),
  fieldType: z.string(),
  groupName: z.string().optional(),
  archived: z.boolean().optional(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
        hidden: z.boolean().optional(),
        displayOrder: z.number().optional(),
      }),
    )
    .optional(),
  modificationMetadata: z
    .object({
      readOnlyValue: z.boolean().optional(),
      readOnlyOptions: z.boolean().optional(),
      readOnlyDefinition: z.boolean().optional(),
    })
    .optional(),
});
export type Property = z.infer<typeof PropertySchema>;
export const LeadSourceSchema = z.object({
  lead_ref: Ref,
  name: z.string(),
  company: z.string().nullable(),
  company_ref: Ref.nullable(),
  crm_contact_id: z.string().nullable(),
  crm_company_id: z.string().nullable(),
  discovery: Json,
  company_discovery: Json.nullable().default(null),
  lead_research: Json.nullable(),
  company_research: Json.nullable(),
});
export type LeadSource = z.infer<typeof LeadSourceSchema>;
export const CrmMappingSourcesRequestSchema = z
  .object({ lead_refs: z.array(Ref).min(1).max(25) })
  .strict();
export const CrmMappingSourcesSchema = z.object({
  workspace_ref: Ref,
  leads: z.array(LeadSourceSchema).max(25),
  research_sources: z
    .array(
      z.object({
        path: z.string(),
        seen_in: z.number().int(),
        sampled: z.number().int(),
      }),
    )
    .optional(),
});
export const CrmMappingCatalogSchema = StateSchema.extend({
  schema_version: Digest,
  properties: z.object({
    contact: z.array(PropertySchema),
    company: z.array(PropertySchema),
  }),
  sources: Json,
});
export const CrmMappingPreviewRequestSchema = ScopeSchema.extend({
  lead_refs: z.array(Ref).min(1).max(25),
  edits: z.array(MappingEditSchema).max(200).optional(),
}).strict();
export const EvaluationSchema = z.object({
  stage: z.enum(["discovery", "research", "outreach", "verification"]),
  entity: z.enum(["lead", "company"]),
  source: Json,
  mappings: z.array(MappingSchema),
});
export const ReplayRecordSchema = z.object({
  lead_refs: z.array(Ref),
  object: ObjectSchema,
  record_id: z.string().regex(/^\d{1,30}$/),
  expected: z.record(z.string(), z.string().nullable()),
  proposed: z.record(z.string(), z.string()),
  evaluations: z.array(EvaluationSchema),
});
export const ReplayPlanSchema = z.object({
  version: z.literal(1),
  records: z.array(ReplayRecordSchema),
});
export type ReplayPlan = z.infer<typeof ReplayPlanSchema>;
export const PreviewIssueSchema = z.object({
  lead_ref: Ref,
  object: ObjectSchema,
  field: z.string().nullable(),
  reason: z.string(),
  value: z.string().optional(),
});
export const CrmMappingPreviewSchema = ScopeSchema.extend({
  schema_version: Digest,
  preview_digest: Digest,
  lead_refs: z.array(Ref),
  applied_mapping: z.boolean(),
  plan: ReplayPlanSchema,
  issues: z.array(PreviewIssueSchema),
});
export const CrmMappingApplyRequestSchema = ScopeSchema.extend({
  schema_version: Digest,
  edits: z.array(MappingEditSchema).min(1).max(200),
}).strict();
export const CrmMappingApplySchema = StateSchema.extend({
  state: z.literal("applied"),
});
export const CrmMappingPropertyCreateRequestSchema = ScopeSchema.extend({
  schema_version: Digest,
  object: ObjectSchema,
  property: z
    .object({
      name: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/),
      label: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      groupName: z.string().min(1),
      type: z.enum([
        "string",
        "number",
        "enumeration",
        "bool",
        "date",
        "datetime",
      ]),
      fieldType: z.enum([
        "text",
        "textarea",
        "number",
        "select",
        "radio",
        "checkbox",
        "booleancheckbox",
        "date",
      ]),
      options: z
        .array(
          z
            .object({
              label: z.string().min(1),
              value: z.string().min(1).max(100),
            })
            .strict(),
        )
        .max(500)
        .optional(),
    })
    .strict(),
}).strict();
export const CrmMappingPropertyCreateSchema = ScopeSchema.extend({
  state: z.enum(["created", "already_exists"]),
  property: PropertySchema,
});
export const CrmMappingSyncRequestSchema = ScopeSchema.extend({
  lead_refs: z.array(Ref).min(1).max(25),
  preview_digest: Digest,
  request_ref: Ref,
}).strict();
export const CrmMappingStatusQuerySchema = z.object({ run_ref: Ref }).strict();
export const CrmMappingStatusSchema = z
  .object({
    run_ref: Ref,
    workspace_ref: Ref,
    status: z.enum(["queued", "running", "succeeded", "partial", "failed"]),
    result: Json.nullable(),
  })
  .passthrough();
export const CrmMappingSyncSchema = CrmMappingStatusSchema;
export type CrmMappingAction =
  | "catalog"
  | "sources"
  | "preview"
  | "apply"
  | "property_create"
  | "sync"
  | "status"
  | "records";
export interface CrmMappingOptions {
  workspaceRef?: string;
  signal?: AbortSignal;
}
export type CrmMappingOperation = (
  session: AuthSession,
  action: CrmMappingAction,
  input?: unknown,
  options?: CrmMappingOptions,
) => Promise<unknown>;
