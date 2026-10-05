import { operationToolNames } from "./operation-names.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  StageErrorSchema,
  StageOperationSchema,
  stageOperations,
  type StageOperation,
} from "./stage-contracts.js";

export const STAGE_CLIENT_CONTRACT = "lifty-cli-context.v9";
export const CLIENT_UPGRADE_MESSAGE = `Update the installed LIFTY CLI and skill to ${STAGE_CLIENT_CONTRACT}. Earlier client contracts are retired. Reload the updated client; setup resumes from the server draft.`;
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
// remain behind the authenticated setup generation-context boundary.
const interview = readFileSync(
  new URL("./agent-context/interview.md", import.meta.url),
  "utf8",
);
const companyMapping = readFileSync(
  new URL("./agent-context/company-mapping.md", import.meta.url),
  "utf8",
);
const calibration = readFileSync(
  new URL("./agent-context/calibration.md", import.meta.url),
  "utf8",
);
const writing = readFileSync(
  new URL("./agent-context/writing.md", import.meta.url),
  "utf8",
);
const antiSlop = readFileSync(
  new URL("./agent-context/anti-slop.md", import.meta.url),
  "utf8",
);
const documents = {
  "step-sample": {
    instructions: readFileSync(
      new URL("./agent-context/step-sample.md", import.meta.url),
      "utf8",
    ),
    schemas: {},
    references: {},
  },
  "step-review": {
    instructions: readFileSync(
      new URL("./agent-context/step-review.md", import.meta.url),
      "utf8",
    ),
    schemas: {},
    references: { calibration, company_mapping: companyMapping },
  },

};
const readGuide = (name: string) =>
  readFileSync(new URL(`./agent-context/${name}.md`, import.meta.url), "utf8");
const configuration = readGuide("configuration");
// The CLI noun after "lifty <verb> <resource>"; a noun equal to the verb is implicit.
function cliNoun(key: string, op: StageOperation) {
  const noun = op.cli?.operation ?? key;
  return noun === op.method.toLowerCase() ? "" : ` ${noun}`;
}
function operationGuide(
  stage: string,
  operations: Record<string, StageOperation>,
) {
  return (
    `## ${stage} operations\n\n` +
    Object.entries(operations)
      .filter(([, op]) =>
        Object.keys(op.responses).some((code) => code.startsWith("2")),
      )
      .map(
        ([key, op]) =>
          `- ${op.route === `/v1/context/${stage}` ? `lifty context ${stage}` : `lifty ${op.method.toLowerCase()} ${stage}${cliNoun(key, op)}`} → ${op.method} ${op.route}; MCP ${operationToolNames(stage, key).join(" / ")}`,
      )
      .join("\n")
  );
}
const stageReferences: Record<string, string> = {
  common: readGuide("stage-common"),
};
const stageDocuments = Object.fromEntries(
  Object.entries(stageOperations).map(([stage, operations]) => [
    stage,
    {
      instructions: readGuide(stage),
      schemas: {},
      operations,
      references: {
        ...stageReferences,
        ...(["crm", "notifications"].includes(stage)
          ? { connections: readGuide("stage-connections") }
          : {}),
        // The interview carries the founder voice and first-reply rules;
        // configuration carries the criteria authoring rules a persona edit
        // needs to regenerate criteria in the same targeting PATCH.
        ...(stage === "business" ? { interview } : {}),
        ...(["setup", "targeting", "research-criteria"].includes(stage)
          ? { interview, configuration }
          : {}),
        ...(["targeting", "research-criteria", "sample-review"].includes(stage)
          ? { calibration }
          : {}),
        ...(["campaigns", "journeys"].includes(stage)
          ? { campaign: readGuide("campaigns"), writing, anti_slop: antiSlop }
          : {}),
        ...(stage === "crm" ? { company_mapping: companyMapping } : {}),
      },
    },
  ]),
);
const indexDocument = {
  instructions: readGuide("stages"),
  schemas: {},
  references: stageReferences,
  operations: {},
};

// Every error response shares one envelope. Publishing it once per document
// instead of once per status code halves the operation payload; clients
// route by method, route and request schema, never by error schemas.
const errorSchema = compactSchema(z.toJSONSchema(StageErrorSchema)) as Record<
  string,
  unknown
>;
function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, item]) => [key, compactSchema(item)]),
  );
}
function compactOperations(operations: Record<string, StageOperation>) {
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      {
        ...operation,
        request: compactSchema(operation.request) as StageOperation["request"],
        responses: Object.fromEntries(
          Object.entries(operation.responses).map(([status, schema]) => [
            status,
            status.startsWith("2")
              ? compactSchema(schema)
              : { $ref: "#/schemas/error" },
          ]),
        ),
      },
    ]),
  );
}

export function getAgentContext(task: string) {
  const stageDocument =
    task === "stages"
      ? indexDocument
      : Object.hasOwn(stageDocuments, task)
        ? stageDocuments[task]
        : undefined;
  if (!Object.hasOwn(documents, task) && !stageDocument) return null;
  const document = stageDocument ?? documents[task as keyof typeof documents];
  const content = {
    format: "lifty-context.v1" as const,
    task,
    ...document,
    ...(stageDocument
      ? {
          instructions:
            task === "stages"
              ? `${document.instructions}\n${Object.keys(stageOperations)
                  .map((stage) => `- [${stage}](/v1/context/${stage})`)
                  .join("\n")}\n${Object.entries(stageOperations)
                  .map(([stage, operations]) =>
                    operationGuide(stage, operations),
                  )
                  .join("\n")}`
              : `${document.instructions}\n${operationGuide(task, stageDocument.operations)}`,
        }
      : {}),
    // Compact per call: operation definitions stay live objects (routes can
    // change at runtime in tests and the revision must follow them).
    ...(stageDocument && task !== "stages"
      ? {
          schemas: { ...stageDocument.schemas, error: errorSchema },
          operations: compactOperations(stageDocument.operations),
        }
      : {}),
  };
  const revision = `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
  return AgentContextSchema.parse({ ...content, revision });
}
