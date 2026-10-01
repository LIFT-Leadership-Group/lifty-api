import { z } from "zod";

export const RepairIssueSchema = z
  .object({
    code: z.string().max(100),
    path: z.string().max(1000),
    message: z.string().max(500),
    suggestion: z.string().max(1000),
  })
  .strict();
const text = (max: number) => z.string().trim().min(1).max(max);
export const WebsiteUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, "Use an HTTP(S) URL without credentials.");
export const valueSchema = (max: number) =>
  z.discriminatedUnion("provenance", [
    z.object({ text: text(max), provenance: z.literal("confirmed") }).strict(),
    z
      .object({
        text: text(max),
        provenance: z.literal("inferred"),
        source: z.enum(["website", "public_research"]),
      })
      .strict(),
  ]);
const unique = <T extends z.ZodType>(
  item: T,
  max: number,
  key: (item: z.output<T>) => string,
) =>
  z
    .array(item)
    .max(max)
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        const normalized = key(item).trim().toLowerCase();
        if (seen.has(normalized))
          context.addIssue({
            code: "custom",
            path: [index],
            message: "Remove duplicate values.",
          });
        seen.add(normalized);
      });
    });
export const WorkspaceIdentitySchema = z
  .object({
    workspace_ref: z.uuid(),
    name: text(200),
    state: z.string().min(1),
  })
  .strict();
const ProfileValues = z
  .object({
    name: text(200),
    website_url: valueSchema(2048)
      .refine((value) => WebsiteUrlSchema.safeParse(value.text).success)
      .nullable(),
    one_liner: valueSchema(300).nullable(),
    description: valueSchema(4000).nullable(),
    value_proposition: valueSchema(500).nullable(),
    offerings: unique(valueSchema(200), 10, (value) => value.text),
    problems_solved: unique(valueSchema(300), 10, (value) => value.text),
  })
  .strict();
export const BusinessProfileSchema = ProfileValues.extend({
  version: z.number().int().positive(),
  updated_at: z.iso.datetime({ offset: true }),
  confirmation: z
    .object({
      complete: z.boolean(),
      missing: z.array(
        z.enum(["value_proposition", "offerings", "problems_solved"]),
      ),
    })
    .strict(),
}).strict();
export const BusinessGetSchema = z
  .object({
    workspace: WorkspaceIdentitySchema.nullable(),
    profile: BusinessProfileSchema.nullable(),
  })
  .strict();
export const BusinessPostSchema = z
  .object({ name: text(200), website_url: WebsiteUrlSchema.nullable() })
  .strict();
export const BusinessPostResultSchema = BusinessGetSchema.extend({
  created: z.boolean(),
  voice: z.object({ version: z.number().int().nonnegative() }).strict(),
}).strict();
const changed = <T extends z.ZodRawShape>(shape: T) =>
  z
    .object(shape)
    .strict()
    .refine(
      (value) => Object.keys(value).some((key) => key !== "expected_version"),
      "Supply at least one changed field.",
    );
export const BusinessPatchSchema = changed({
  expected_version: z.number().int().positive(),
  ...ProfileValues.partial().shape,
});
export const VoiceRuleSchema = z
  .object({
    kind: z.enum(["do", "avoid"]),
    text: text(200),
    source: z.enum(["founder", "founder_feedback", "migration"]),
  })
  .strict();
export const VoiceValuesSchema = z
  .object({
    tone: text(300).nullable(),
    rules: unique(
      VoiceRuleSchema,
      20,
      (value) => `${value.kind}:${value.text}`,
    ),
  })
  .strict();
export const VoicePatchSchema = changed({
  expected_version: z.number().int().nonnegative(),
  ...VoiceValuesSchema.partial().shape,
});
export const VoiceSchema = VoiceValuesSchema.extend({
  version: z.number().int().nonnegative(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export const VoiceGetSchema = z
  .object({ workspace_ref: z.uuid(), voice: VoiceSchema })
  .strict();
const list = (max = 50) => unique(text(200), max, (value) => value).nullable();
export const SenioritySchema = z.enum([
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
]);
export const PersonaSchema = z
  .object({
    id: z.uuid(),
    name: text(120),
    titles: unique(text(200), 30, (value) => value).min(1),
    persona_type: text(100).nullable(),
  })
  .strict();
const EmployeeRangeSchema = z
  .object({
    min: z.number().int().min(1).max(10000000),
    max: z.number().int().min(1).max(10000000).nullable(),
  })
  .strict()
  .refine((value) => value.max === null || value.max >= value.min);
export const EmployeesSchema = z.union([
  EmployeeRangeSchema,
  z
    .object({
      ranges: z
        .array(EmployeeRangeSchema)
        .min(1)
        .max(20)
        .superRefine((ranges, ctx) => {
          ranges.forEach((range, index) => {
            const prior = ranges[index - 1];
            if (prior && (prior.max === null || range.min <= prior.max))
              ctx.addIssue({
                code: "custom",
                path: [index],
                message: "Use ordered, non-overlapping employee ranges.",
              });
          });
        }),
    })
    .strict(),
]);
export const CompanyTargetingSchema = z
  .object({
    locations: list(),
    industries: list(),
    industry_codes: unique(
      z.string().regex(/^[0-9]{2,6}$/),
      100,
      (value) => value,
    ).nullable(),
    excluded_industry_codes: unique(
      z.string().regex(/^[0-9]{2,6}$/),
      100,
      (value) => value,
    ).nullable(),
    domains: unique(
      z
        .string()
        .trim()
        .max(253)
        .regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/),
      100,
      (value) => value,
    ).nullable(),
    employees: EmployeesSchema.nullable(),
    keywords: text(1000).nullable(),
  })
  .strict();
export const TargetingLaneSchema = z
  .object({
    id: z.uuid(),
    name: text(120),
    personas: unique(PersonaSchema, 30, (value) => value.id).min(1),
    seniorities: unique(SenioritySchema, 11, (value) => value).nullable(),
    person_locations: list(),
    company: CompanyTargetingSchema,
  })
  .strict();
export const TargetingValuesSchema = z
  .object({
    lanes: unique(TargetingLaneSchema, 20, (value) => value.id).min(1),
  })
  .strict();
export const TargetingSchema = TargetingValuesSchema.extend({
  version: z.number().int().positive(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export const TargetingGetSchema = z
  .object({ workspace_ref: z.uuid(), targeting: TargetingSchema.nullable() })
  .strict();
// Independent Scout requirements preserve the canonical source contract, never CRM delivery mappings.
export const ScoutInputFieldSchema = z
  .object({
    source_stage: z.enum(["discovery", "research", "outreach", "verification"]),
    source_entity: z.enum(["lead", "company"]),
    source_field: text(200),
    source_path: z.array(text(200)).min(1).max(10),
    label: text(200).nullable(),
    transform_config: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
    required_from_agent: z.boolean(),
    transform: z.string().optional(),
    write_rule: z.string().optional(),
    value_source: z.string().optional(),
  })
  .passthrough();
export const ScoutInputContractSchema = z
  .object({
    version: z.literal(1),
    fields: z.array(ScoutInputFieldSchema).max(200),
  })
  .strict();
export const SourceVersionsSchema = z
  .object({
    profile_version: z.number().int().positive(),
    draft_version: z.number().int().positive().optional(),
    targeting_version: z.number().int().positive().optional(),
    base_version: text(200),
  })
  .strict();
export const CriteriaValuesSchema = z
  .object({
    text: z.string().trim().min(200).max(64000).nullable(),
    input_contract: ScoutInputContractSchema.nullable(),
    qualification_policy: z.enum(["person_first", "company_first"]),
    hand_tuned: z.boolean(),
    source_versions: SourceVersionsSchema,
  })
  .strict();
export const CriteriaSchema = CriteriaValuesSchema.extend({
  version: z.number().int().positive(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict();
export const CriteriaGetSchema = z
  .object({ workspace_ref: z.uuid(), criteria: CriteriaSchema.nullable() })
  .strict();
export const CriteriaPatchSchema = changed({
  expected_version: z.number().int().positive(),
  ...CriteriaValuesSchema.partial().shape,
}).refine(
  (value) => value.text === undefined || value.source_versions !== undefined,
  "A text edit must carry current source versions.",
);
export const TargetingLanePatchSchema = TargetingLaneSchema.partial()
  .extend({
    id: z.uuid(),
    company: CompanyTargetingSchema.partial().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== "id"),
    "Supply a changed lane field.",
  );
export const TargetingPatchSchema = z
  .object({
    expected_version: z.number().int().positive(),
    lanes: unique(TargetingLanePatchSchema, 20, (value) => value.id).min(1),
    regenerated_criteria: CriteriaValuesSchema.extend({
      expected_version: z.number().int().positive(),
    }).optional(),
  })
  .strict();
export const CriteriaInputsSchema = z
  .object({
    disqualifiers: unique(text(1000), 30, (value) => value),
    operating_state: text(1000).nullable(),
    primary_motion: z
      .object({ name: text(200), why_now: text(2000) })
      .strict()
      .nullable(),
    parked_motions: unique(text(500), 20, (value) => value),
    personas: z
      .array(
        z
          .object({
            persona_id: z.uuid(),
            role: z.enum(["decision_maker", "influencer"]),
            tell: text(1000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const SetupDraftSchema = z
  .object({
    targeting: TargetingValuesSchema.nullable(),
    criteria_inputs: CriteriaInputsSchema,
    evidence: z
      .array(
        z
          .object({
            kind: z.enum(["website", "public_research", "founder_statement"]),
            text: text(4000),
            source_url: WebsiteUrlSchema.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const SetupGatesSchema = z
  .object({
    next: z
      .enum(["motion", "market", "exclusions", "boundaries", "persona"])
      .nullable(),
    missing: z.array(
      z.enum(["motion", "market", "exclusions", "boundaries", "persona"]),
    ),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }).strict())
      .max(20),
  })
  .strict();
export const SetupDraftGetSchema = z
  .object({
    workspace_ref: z.uuid(),
    version: z.number().int().nonnegative(),
    draft: SetupDraftSchema.nullable(),
    generated_criteria: CriteriaValuesSchema.nullable(),
    gates: SetupGatesSchema,
    submitted: z.boolean(),
    updated_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const SetupDraftPatchSchema = z
  .object({
    expected_version: z.number().int().nonnegative(),
    draft: SetupDraftSchema,
    generated_criteria: CriteriaValuesSchema.nullable(),
  })
  .strict()
  .refine(
    (value) =>
      value.generated_criteria === null ||
      value.generated_criteria.source_versions.draft_version ===
        value.expected_version + 1,
    "Generated criteria must bind the resulting draft version.",
  );
export const SetupPostSchema = z
  .object({ expected_draft_version: z.number().int().positive() })
  .strict();
export const SetupStatusSchema = z.discriminatedUnion("state", [
  z.object({ workspace_ref: z.uuid(), state: z.literal("none") }).strict(),
  z
    .object({
      workspace_ref: z.uuid(),
      state: z.literal("imported"),
      setup_ref: z.uuid(),
      draft_version: z.number().int().positive(),
      profile_version: z.number().int().positive(),
      targeting_version: z.number().int().positive(),
      criteria_version: z.number().int().positive(),
      submitted_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
]);
export const SetupDiscardSchema = z
  .object({ workspace_ref: z.uuid(), discarded: z.literal(true) })
  .strict();
export const SetupContextDataSchema = z
  .object({
    workspace_ref: z.uuid(),
    profile: BusinessProfileSchema,
    draft: SetupDraftGetSchema,
    base: z
      .object({ version: text(200), text: z.string().min(1).max(200000) })
      .strict(),
  })
  .strict();
export const SetupContextSchema = SetupContextDataSchema.extend({
  generation_rules: z.array(z.string()),
  criteria_schema: z.record(z.string(), z.unknown()),
  draft_schema: z.record(z.string(), z.unknown()),
}).strict();
export const SETUP_GENERATION_RULES = [
  "Use only confirmed profile facts. Keep business facts out of the criteria text: Scout receives the versioned profile at run time.",
  "Generate only Scout criteria from the server draft. Structured Targeting filters run before research; never duplicate filterable exclusions as research rules.",
  "Include ICP gate, evidence-based hard disqualifiers, operating-state split and A/B/C tier definitions. Preserve primary and parked motions and each persona role and tell.",
  "Use the current base text returned here; do not invent or request a hidden base. Preserve its mandatory output requirements and platform rules.",
  "Save generated criteria with profile_version, the resulting draft_version and base_version from this context. Changed sources require fresh generation.",
  "Setup writes Targeting and criteria once. Saving or submitting setup does not activate recurring research or outreach.",
];
