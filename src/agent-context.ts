import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigUpdateRequestSchema } from "./contracts.js";
import { EmailCampaignRequest } from "./email-campaign-contracts.js";
import { LinkedinCampaignRequest } from "./linkedin-campaign-contracts.js";
import { WorkspaceCampaignRequest, WorkspaceCampaignResult } from "./workspace-campaign-contracts.js";
import { StageErrorSchema, StageOperationSchema, stageOperations, type StageOperation } from "./stage-contracts.js";

export const STAGE_CLIENT_CONTRACT = "lifty-cli-context.v5";
export const CLIENT_UPGRADE_MESSAGE = `Update the installed LIFTY CLI and skill to ${STAGE_CLIENT_CONTRACT}. Client contracts v4 and earlier are retired; preserve local drafts and configuration until the update is complete.`;
export const AgentContextSchema = z.object({
  format: z.literal("lifty-context.v1"),
  task: z.string().min(1),
  revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instructions: z.string().min(1),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  references: z.record(z.string(), z.string()),
  operations: z.record(z.string(), StageOperationSchema).optional(),
});

// Only checked-in public guidance goes here. Tenant data and the Scout base
// remain behind the existing authenticated /v1/onboarding/context boundary.
const interview = readFileSync(new URL("./agent-context/interview.md", import.meta.url), "utf8");
const companyMapping = readFileSync(new URL("./agent-context/company-mapping.md", import.meta.url), "utf8");
const calibration = readFileSync(new URL("./agent-context/calibration.md", import.meta.url), "utf8");
const writing = readFileSync(new URL("./agent-context/writing.md", import.meta.url), "utf8");
const antiSlop = readFileSync(new URL("./agent-context/anti-slop.md", import.meta.url), "utf8");
const documents = {
  onboarding: {
    instructions: readFileSync(new URL("./agent-context/onboarding.md", import.meta.url), "utf8"),
    schemas: { draft: JSON.parse(readFileSync(new URL("./agent-context/draft.schema.json", import.meta.url), "utf8")) },
    references: { interview, calibration, configuration: readFileSync(new URL("./agent-context/configuration.md", import.meta.url), "utf8") },
  },
  workspace: {
    instructions: readFileSync(new URL("./agent-context/workspace.md", import.meta.url), "utf8"),
    schemas: { config_update: z.toJSONSchema(ConfigUpdateRequestSchema, { io: "input" }) },
    references: { interview, calibration },
  },
  campaign: {
    instructions: readFileSync(new URL("./agent-context/campaign.md", import.meta.url), "utf8"),
    schemas: {
      workspace_campaign: z.toJSONSchema(WorkspaceCampaignRequest, { io: "input" }),
      workspace_campaign_result: z.toJSONSchema(WorkspaceCampaignResult),
      email_campaign: z.toJSONSchema(EmailCampaignRequest, { io: "input" }),
      linkedin_campaign: z.toJSONSchema(LinkedinCampaignRequest, { io: "input" }),
    },
    references: { calibration, writing, anti_slop: antiSlop },
  },
};

const readGuide = (name: string) => readFileSync(new URL(`./agent-context/${name}.md`, import.meta.url), "utf8");
const stageReferences: Record<string, string> = {
  common: readGuide("stage-common"),
};
const stageDocuments = Object.fromEntries(Object.entries(stageOperations).map(([stage, operations]) => [stage, {
  instructions: readGuide(stage),
  schemas: ["business", "targeting", "research-criteria", "commercial-voice"].includes(stage)
    ? { draft: documents.onboarding.schemas.draft } : {},
  operations,
  references: {
    ...stageReferences,
    ...(["crm", "sending-accounts", "notifications"].includes(stage)
      ? { connections: readGuide("stage-connections") } : {}),
    ...(["business", "targeting", "research-criteria", "commercial-voice"].includes(stage)
      ? { interview, configuration: readGuide("configuration") } : {}),
    ...(["targeting", "research-criteria", "sample-review"].includes(stage) ? { calibration } : {}),
    ...(stage === "campaigns" ? { campaign: readGuide("campaign"), writing, anti_slop: antiSlop } : {}),
    ...(stage === "crm" ? { company_mapping: companyMapping } : {}),
  },
}]));
const indexDocument = { instructions: readGuide("stages"), schemas: {}, references: stageReferences, operations: {} };

// Step playbooks are what next_step returns: the current step's actions and
// only the references that step needs. Full stage guides stay one
// summary_context call away.
const stepPlaybook = { interview: readGuide("step-interview"), configuration: readGuide("step-configuration"),
  sample: readGuide("step-sample"), review: readGuide("step-review") };
const stepDocuments: Record<string, { instructions: string; schemas: Record<string, Record<string, unknown>>; references: Record<string, string> }> = {
  "step-interview": { instructions: stepPlaybook.interview, schemas: { draft: documents.onboarding.schemas.draft }, references: { interview } },
  "step-configuration": { instructions: stepPlaybook.configuration, schemas: {}, references: { configuration: readGuide("configuration") } },
  "step-submission": { instructions: stepPlaybook.configuration, schemas: {}, references: {} },
  "step-sample": { instructions: stepPlaybook.sample, schemas: {}, references: {} },
  "step-sample-failed": { instructions: stepPlaybook.sample, schemas: {}, references: { calibration } },
  "step-review": { instructions: stepPlaybook.review, schemas: {}, references: { calibration, company_mapping: companyMapping } },
};

// Every error response shares one envelope. Publishing it once per document
// instead of once per status code halves the operation payload; clients
// route by method, route and request schema, never by error schemas.
const errorSchema = compactSchema(z.toJSONSchema(StageErrorSchema)) as Record<string, unknown>;
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema")
    .map(([key, item]) => [key, compactSchema(item)]));
}
function compactOperations(operations: Record<string, StageOperation>) {
  return Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, {
    ...operation,
    request: compactSchema(operation.request) as StageOperation["request"],
    responses: Object.fromEntries(Object.entries(operation.responses).map(([status, schema]) =>
      [status, status.startsWith("2") ? compactSchema(schema) : { $ref: "#/schemas/error" }])),
  }]));
}

export function getAgentContext(task: string) {
  if (Object.hasOwn(stepDocuments, task)) {
    const content = { format: "lifty-context.v1" as const, task, ...stepDocuments[task]! };
    const revision = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
    return AgentContextSchema.parse({ ...content, revision });
  }
  const stageDocument = task === "stages" ? indexDocument
    : Object.hasOwn(stageDocuments, task) ? stageDocuments[task] : undefined;
  if (!Object.hasOwn(documents, task) && !stageDocument) return null;
  const document = stageDocument ?? documents[task as keyof typeof documents];
  const content = { format: "lifty-context.v1" as const, task, ...document,
    ...(!stageDocument && task !== "campaign"
      ? { instructions: `${document.instructions}\n${companyMapping}` } : {}),
    // Compact per call: operation definitions stay live objects (routes can
    // change at runtime in tests and the revision must follow them).
    ...(stageDocument && task !== "stages" ? {
      schemas: { ...stageDocument.schemas, error: errorSchema },
      operations: compactOperations(stageDocument.operations),
    } : {}),
  };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return AgentContextSchema.parse({ ...content, revision });
}
