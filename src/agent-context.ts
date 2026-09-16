import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigUpdateRequestSchema } from "./contracts.js";
import { EmailCampaignRequest } from "./email-campaign-contracts.js";
import { LinkedinCampaignRequest } from "./linkedin-campaign-contracts.js";

export const AGENT_CLIENT_CONTRACT = "lifty-cli-context.v1";
export const COMPANY_MAPPING_CLIENT_CONTRACT = "lifty-cli-context.v2";
export const LOCAL_CONFIG_CLIENT_CONTRACT = "lifty-cli-context.v3";
export const AgentContextSchema = z.object({
  format: z.literal("lifty-context.v1"),
  task: z.string().min(1),
  revision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instructions: z.string().min(1),
  schemas: z.record(z.string(), z.record(z.string(), z.unknown())),
  references: z.record(z.string(), z.string()),
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

export function getAgentContext(task: string, clientContract = AGENT_CLIENT_CONTRACT) {
  if (!Object.hasOwn(documents, task)) return null;
  const document = task === "workspace" && clientContract !== LOCAL_CONFIG_CLIENT_CONTRACT
    ? { instructions: "Your installed LIFTY CLI cannot perform local configuration updates. Upgrade the installed CLI and skills, then fetch workspace context again before changing targeting, personas, tone or prompts. Hosted generation is no longer available. Read-only get/status and simple workspace name/description updates remain available. Never send a legacy regeneration request.", schemas: {}, references: {} }
    : documents[task as keyof typeof documents];
  const content = { format: "lifty-context.v1" as const, task, ...document,
    // v1 clients cannot execute the company commands. Keep their guidance intact.
    ...([COMPANY_MAPPING_CLIENT_CONTRACT, LOCAL_CONFIG_CLIENT_CONTRACT].includes(clientContract) && task !== "campaign"
      ? { instructions: `${document.instructions}\n${companyMapping}` } : {}),
  };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return AgentContextSchema.parse({ ...content, revision });
}
