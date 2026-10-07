// Generated from lift-gtm-jobs/src/lib/outreach-rulebook/anti-slop.ts; regenerate with scripts/sync-writing-rules.mjs.
export type AntiSlopChannel = "global" | "linkedin" | "email";

export interface AntiSlopRule {
  phrase: string;
  normalizedPhrase: string;
  channel: AntiSlopChannel;
  reason: string | null;
}

export interface AntiSlopMatch {
  rule: AntiSlopRule;
  matchedText: string;
}

export interface ScanAntiSlopOptions {
  channel: Exclude<AntiSlopChannel, "global">;
  rules: AntiSlopRule[];
}

const CHANNEL_HEADINGS: Record<string, AntiSlopChannel> = {
  global: "global",
  linkedin: "linkedin",
  "linked in": "linkedin",
  email: "email",
};

export function normalizeAntiSlopPhrase(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function parseAntiSlopMarkdown(markdown: string): AntiSlopRule[] {
  const rules: AntiSlopRule[] = [];
  let channel: AntiSlopChannel = "global";

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const heading = line.match(/^#{2,6}\s+(.+)$/);
    if (heading) {
      const normalizedHeading = normalizeAntiSlopPhrase(
        heading[1]!.replace(/:$/, ""),
      );
      channel = CHANNEL_HEADINGS[normalizedHeading] ?? channel;
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (!bullet) continue;

    const [phrasePart = "", ...reasonParts] = bullet[1]!.split(/\s+\/\/\s+/);
    const phrase = phrasePart.trim().replace(/^`|`$/g, "");
    if (!phrase) continue;
    const reason = reasonParts.join(" // ").trim() || null;
    rules.push({
      phrase,
      normalizedPhrase: normalizeAntiSlopPhrase(phrase),
      channel,
      reason,
    });
  }

  return rules;
}

export function scanAntiSlop(
  text: string,
  options: ScanAntiSlopOptions,
): AntiSlopMatch[] {
  const matches: AntiSlopMatch[] = [];
  for (const rule of options.rules) {
    if (rule.channel !== "global" && rule.channel !== options.channel) continue;
    const matchedText = findRuleMatch(text, rule.normalizedPhrase);
    if (matchedText) matches.push({ rule, matchedText });
  }
  return matches;
}

export function buildAntiSlopPromptBlock(
  rules: AntiSlopRule[],
  options: { channel: Exclude<AntiSlopChannel, "global"> },
): string {
  const globalRules = rules.filter((rule) => rule.channel === "global");
  const channelRules = rules.filter((rule) => rule.channel === options.channel);
  const sections = [
    renderPromptRuleSection("Global", globalRules),
    renderPromptRuleSection(channelLabel(options.channel), channelRules),
  ].filter(Boolean);

  return [
    "<active_anti_slop_rules>",
    "These phrases are active runtime policy. Do not emit copy containing them; rewrite before returning JSON.",
    "",
    sections.join("\n\n"),
    "</active_anti_slop_rules>",
  ].join("\n");
}

export function appendAntiSlopPromptBlock(
  promptSnapshot: string | null | undefined,
  rules: AntiSlopRule[],
  options: { channel: Exclude<AntiSlopChannel, "global"> },
): string | undefined {
  const prompt = promptSnapshot?.trim();
  if (!prompt) return undefined;
  const block = buildAntiSlopPromptBlock(rules, options);
  return `${prompt}\n\n${block}`;
}

export function matchesForDetail(matches: AntiSlopMatch[]): string[] {
  return matches.map((match) => match.rule.phrase);
}

function renderPromptRuleSection(label: string, rules: AntiSlopRule[]): string {
  if (rules.length === 0) return "";
  return [
    `${label}:`,
    ...rules.map((rule) =>
      rule.reason ? `- ${rule.phrase} (${rule.reason})` : `- ${rule.phrase}`,
    ),
  ].join("\n");
}

function channelLabel(channel: Exclude<AntiSlopChannel, "global">): string {
  return channel === "linkedin" ? "LinkedIn" : "Email";
}

function findRuleMatch(text: string, normalizedPhrase: string): string | null {
  const haystack = text.toLowerCase();
  const phrase = normalizedPhrase.toLowerCase();
  if (/^[a-z0-9']+$/.test(phrase)) {
    const re = new RegExp(`(^|[^a-z0-9'])(${escapeRegExp(phrase)})(?=$|[^a-z0-9'])`, "i");
    return text.match(re)?.[2] ?? null;
  }
  const index = haystack.indexOf(phrase);
  if (index === -1) return null;
  return text.slice(index, index + phrase.length);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
