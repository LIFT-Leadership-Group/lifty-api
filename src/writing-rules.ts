import { z } from "zod";
import { parseAntiSlopMarkdown, scanAntiSlop, type AntiSlopRule } from "./generated/anti-slop.js";

// The banned-phrase list is one database rulebook (outreach_rulebooks key
// anti_slop) that Jobs also composes and checks against. Lifty reads it live
// instead of keeping its own copy, and every phrase is a recommendation:
// it never blocks a save, a preview or an approval (Juan, 2026-10-07).

export interface WritingRules { rules: AntiSlopRule[]; updatedAt: string }

const Served = z.object({
  anti_slop: z.object({ markdown: z.string().min(1).max(64000), updated_at: z.string().min(1) }).strict(),
}).strict();

let current: WritingRules | null = null;

/** The last list read from the database, or null before the first read. */
export const currentWritingRules = () => current;
/** Tests and the refresher set the served list; null forgets it. */
export function setWritingRules(rules: WritingRules | null) { current = rules; }

export interface WritingRulesSettings { supabaseUrl: string; publishableKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }

/** Read the shared list through the public RPC. A failed or empty read keeps
 * the previous list: an outage never replaces known rules with nothing. */
export async function refreshWritingRules(settings: WritingRulesSettings): Promise<boolean> {
  try {
    const response = await (settings.fetchImpl ?? fetch)(`${settings.supabaseUrl}/rest/v1/rpc/get_lifty_writing_rules`, {
      method: "POST",
      headers: { apikey: settings.publishableKey, "content-type": "application/json", accept: "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(settings.timeoutMs ?? 5_000),
    });
    if (!response.ok) return false;
    const parsed = Served.safeParse(await response.json());
    if (!parsed.success) return false;
    const rules = parseAntiSlopMarkdown(parsed.data.anti_slop.markdown);
    if (!rules.length) return false;
    current = { rules, updatedAt: parsed.data.anti_slop.updated_at };
    return true;
  } catch {
    return false;
  }
}

/** Read now and every few minutes, so a rulebook edit reaches Lifty without a deploy. */
export function startWritingRulesRefresh(settings: WritingRulesSettings, intervalMs = 5 * 60_000): () => void {
  void refreshWritingRules(settings);
  const timer = setInterval(() => void refreshWritingRules(settings), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

const SECTIONS = [["global", "Global"], ["email", "Email"], ["linkedin", "LinkedIn"]] as const;

/** The list appended to the anti-slop context file. */
export function liveAntiSlopSection(): string {
  if (!current) {
    return "## Current list\n\nThe shared list could not be read right now. Avoid stock hedges (\"I'm guessing\", \"it looks like\", \"seems like\") and cold-email clichés, and check the campaign's `writing_recommendations` after saving.";
  }
  return SECTIONS.flatMap(([channel, title]) => {
    const rules = current!.rules.filter(rule => rule.channel === channel);
    return rules.length ? [`## ${title}\n\n${rules.map(rule => `- ${rule.phrase}${rule.reason ? ` (${rule.reason})` : ""}`).join("\n")}`] : [];
  }).join("\n\n");
}

export const WritingRecommendationsSchema = z.object({
  revision_ref: z.uuid(),
  phrases: z.array(z.object({
    position: z.number().int().positive(),
    template: z.string().nullable(),
    field: z.enum(["subject", "text"]),
    phrase: z.string(),
  }).strict()),
}).strict();
export type WritingRecommendations = z.infer<typeof WritingRecommendationsSchema>;

interface ScannedTemplate { id?: string | undefined; lane?: string | undefined; opener?: string | undefined; subject?: string | undefined; text: string }
interface ScannedRevision {
  revision_ref: string;
  content: { steps: Array<{ position: number; template?: ScannedTemplate | undefined; variants?: ScannedTemplate[] | undefined }> };
}

/** Banned phrases in a revision's saved templates, per step and field. Null
 * when the list is unknown, so an unread list never reads as clean copy. */
export function writingRecommendations(revision: ScannedRevision, channel: "email" | "linkedin"): WritingRecommendations | null {
  if (!current) return null;
  const rules = current.rules;
  const phrases = revision.content.steps.flatMap(step =>
    [...(step.template ? [step.template] : []), ...(step.variants ?? [])].flatMap(template => {
      const ref = template.id ?? ([template.lane, template.opener].filter(Boolean).join("/") || null);
      return (["subject", "text"] as const).flatMap(field => {
        const value = template[field];
        return value ? scanAntiSlop(value, { channel, rules }).map(match =>
          ({ position: step.position, template: ref, field, phrase: match.rule.phrase })) : [];
      });
    }));
  return { revision_ref: revision.revision_ref, phrases };
}
