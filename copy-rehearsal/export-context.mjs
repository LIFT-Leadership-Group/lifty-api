import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentContext } from "../src/agent-context.ts";

const root = dirname(fileURLToPath(import.meta.url));
const scratch = join(root, "scratch");
const promptsDir = join(scratch, "prompts");
const draftsDir = join(scratch, "drafts");
const scenariosDir = join(root, "scenarios");

mkdirSync(promptsDir, { recursive: true });
mkdirSync(draftsDir, { recursive: true });

function renderContext(context) {
  if (!context) throw new Error("getAgentContext returned no document");
  const references = context.references ?? {};
  const lines = [
    `# Assembled Lifty context: ${context.task}`,
    "",
    `Revision: ${context.revision}`,
    `Format: ${context.format}`,
    "",
    "This dump is the assembled context Lifty serves for this task, including",
    "every reference. It is for local copy rehearsal only.",
    "",
    "## Instructions",
    "",
    String(context.instructions).trim(),
    "",
  ];
  for (const [name, text] of Object.entries(references)) {
    lines.push(`## Reference: ${name}`, "", String(text).trim(), "");
  }
  return { markdown: `${lines.join("\n").trim()}\n`, references };
}

function exportTask(task, requiredReferences = []) {
  const context = getAgentContext(task);
  const { markdown, references } = renderContext(context);
  for (const name of requiredReferences) {
    if (!references[name] || String(references[name]).trim().length === 0) {
      throw new Error(`${task} is missing required references.${name}`);
    }
  }
  writeFileSync(join(scratch, `${task}.json`), `${JSON.stringify(context, null, 2)}\n`);
  writeFileSync(join(scratch, `${task}.md`), markdown);
  return context;
}

const campaigns = exportTask("campaigns", ["campaign", "writing", "anti_slop", "common"]);
const commercialVoice = exportTask("commercial-voice", ["common", "interview", "configuration"]);

const rehearsalRules = `You are running a local Lifty copy rehearsal, not a live onboarding session.

Hard limits:
- Use only the fictional saved company information in the scenario.
- Generate drafts locally. Do not log in, read a hosted workspace, save a campaign, activate outreach, or send messages.
- Keep current product behavior: LinkedIn is an invitation with no note, then three messages after acceptance. Email is five messages. Each email needs a subject and body.
- Follow references.writing and references.anti_slop for copy shape. LinkedIn sentences in a message must be one connected thought. Emails use that guide's six fields, the same subject on all five steps, Hi/Hey plus {{first_name}} on every greeting, pain on 1-2, offer on 3-4, and a soft thank-you plus different-person ask on 5.
- Name the author from the saved founder or sender. Use first person as that person. The lead has to know who wrote a cold message.
- Print each email as it would appear in an inbox, with a blank line after the greeting, opener, main focus, and hook. Do not collapse fields onto one paragraph.
- Do not use phrases from references.anti_slop, including "quick question".
- Only {{first_name}}, {{last_name}}, and {{company_name}} are allowed substitutions.
- Templates must work for the approved audience, including future eligible leads. Do not invent recipient-specific research or unsupported placeholders.
- Preserve channel choice, cadence, stop-on-reply, and campaign approval requirements. Do not propose a different sequence length or send path.
- Do not use previous drafts or any editing discussion. Use only this scenario and the assembled guidance files named below.

Show the copy so it can be judged. For each channel, include:
1. The recommended angle in a few sentences, including which saved facts you used.
2. The full templates. For email, show the composed inbox view first (subject, greeting with {{first_name}}, then opener, main focus, hook, and CTA separated by blank lines). Label the six fields only after that.
3. A short checklist against specificity, credibility, named author, voice, CTA, connected flow, anti-slop, and whether each follow-up adds a useful reason to reply.

If a fact is missing, stay general. Do not invent customers, results, websites, pain, or prior conversations.`;

const scenarioFiles = readdirSync(scenariosDir).filter((name) => name.endsWith(".md")).sort();
if (scenarioFiles.length === 0) throw new Error("No scenario files found");

for (const fileName of scenarioFiles) {
  const scenarioName = fileName.replace(/\.md$/, "");
  const scenario = readFileSync(join(scenariosDir, fileName), "utf8").trim();
  const prompt = `# Lifty copy rehearsal

${rehearsalRules}

## Scenario (fixed input)

Read \`copy-rehearsal/scenarios/${fileName}\` and use it as the saved company context:

${scenario}

## Current assembled guidance

Read these local export files. They were generated from getAgentContext in a fresh process. Use them as the product guidance. Include every reference, especially \`references.campaign\`.

- \`copy-rehearsal/scratch/campaigns.md\`
  - task: campaigns
  - revision: ${campaigns.revision}
  - references: ${Object.keys(campaigns.references).join(", ")}
- \`copy-rehearsal/scratch/commercial-voice.md\`
  - task: commercial-voice
  - revision: ${commercialVoice.revision}
  - references: ${Object.keys(commercialVoice.references).join(", ")}

The campaigns export must include \`references.campaign\`. If that section is missing, stop and say so.

After reading those files, recommend the LinkedIn and email drafts for this scenario.
`;
  writeFileSync(join(promptsDir, fileName), prompt);
}

const manifest = {
  exported_at: new Date().toISOString(),
  note: "Local copy rehearsal dump. Not a hosted campaign. Not for sending.",
  campaigns_revision: campaigns.revision,
  commercial_voice_revision: commercialVoice.revision,
  campaigns_references: Object.keys(campaigns.references),
  commercial_voice_references: Object.keys(commercialVoice.references),
  scenarios: scenarioFiles.map((name) => name.replace(/\.md$/, "")),
};
writeFileSync(join(scratch, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log("Copy rehearsal export complete.");
console.log(`campaigns revision: ${campaigns.revision}`);
console.log(`commercial-voice revision: ${commercialVoice.revision}`);
console.log(`campaigns references: ${manifest.campaigns_references.join(", ")}`);
console.log(`commercial-voice references: ${manifest.commercial_voice_references.join(", ")}`);
console.log(`prompts: ${scenarioFiles.map((name) => `copy-rehearsal/scratch/prompts/${name}`).join(", ")}`);
console.log("Drafts belong in copy-rehearsal/scratch/drafts/ and stay uncommitted.");
