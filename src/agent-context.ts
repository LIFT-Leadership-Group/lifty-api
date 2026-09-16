import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigUpdateRequestSchema } from "./contracts.js";
import { EmailCampaignRequest } from "./email-campaign-contracts.js";
import { LinkedinCampaignRequest } from "./linkedin-campaign-contracts.js";
import { StageOperationSchema, stageOperations } from "./stage-contracts.js";

export const AGENT_CLIENT_CONTRACT = "lifty-cli-context.v1";
export const COMPANY_MAPPING_CLIENT_CONTRACT = "lifty-cli-context.v2";
export const LOCAL_CONFIG_CLIENT_CONTRACT = "lifty-cli-context.v3";
export const CALIBRATION_CLIENT_CONTRACT = "lifty-cli-context.v4";
export const STAGE_CLIENT_CONTRACT = "lifty-cli-context.v5";
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
      email_campaign: z.toJSONSchema(EmailCampaignRequest, { io: "input" }),
      linkedin_campaign: z.toJSONSchema(LinkedinCampaignRequest, { io: "input" }),
    },
    references: { calibration },
  },
};

const readGuide = (name: string) => readFileSync(new URL(`./agent-context/${name}.md`, import.meta.url), "utf8");
const stageReferences: Record<string, string> = {
  common: readGuide("stage-common"),
};
const stageDocuments = Object.fromEntries(Object.entries(stageOperations).map(([stage, operations]) => [stage, {
  instructions: readGuide(stage),
  schemas: ["targeting", "research-criteria", "commercial-voice"].includes(stage)
    ? { draft: documents.onboarding.schemas.draft } : {},
  operations,
  references: {
    ...stageReferences,
    ...(["crm", "sending-accounts", "notifications"].includes(stage)
      ? { connections: readGuide("stage-connections") } : {}),
    ...(["targeting", "research-criteria", "commercial-voice"].includes(stage)
      ? { interview, configuration: readGuide("configuration") } : {}),
    ...(["targeting", "research-criteria", "sample-review"].includes(stage) ? { calibration } : {}),
    ...(stage === "campaigns" ? { campaign: readGuide("campaign") } : {}),
    ...(stage === "crm" ? { company_mapping: companyMapping } : {}),
  },
}]));
const indexDocument = { instructions: readGuide("stages"), schemas: {}, references: stageReferences, operations: {} };

export function getAgentContext(task: string, clientContract = AGENT_CLIENT_CONTRACT) {
  const stageDocument = task === "stages" ? indexDocument
    : Object.hasOwn(stageDocuments, task) ? stageDocuments[task] : undefined;
  if (!Object.hasOwn(documents, task) && !stageDocument) return null;
  const currentClient = [CALIBRATION_CLIENT_CONTRACT, STAGE_CLIENT_CONTRACT].includes(clientContract);
  const document = !currentClient || (stageDocument && clientContract !== STAGE_CLIENT_CONTRACT)
    ? { instructions: "Upgrade the installed LIFTY CLI and skills, then fetch current task context again. This version cannot review the current A/B calibration policy or capture explicit discovery intent. Do not start another lead run from old instructions. Hosted generation is no longer available. Read-only get/status and simple workspace name/description updates remain available. Preserve the confirmed draft and saved candidates during the upgrade.", schemas: {}, references: {} }
    : stageDocument ?? documents[task as keyof typeof documents];
  const content = { format: "lifty-context.v1" as const, task, ...document,
    ...(currentClient && !stageDocument && task !== "campaign"
      ? { instructions: `${document.instructions}\n${companyMapping}` } : {}),
  };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return AgentContextSchema.parse({ ...content, revision });
}
