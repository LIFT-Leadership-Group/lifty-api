import { resolveMx, resolveTxt } from "node:dns/promises";

/** node:dns/promises shape; injected so tests never touch the network. */
export interface WarmupDnsResolver {
  resolveMx(hostname: string): Promise<Array<{ exchange: string; priority: number }>>;
  resolveTxt(hostname: string): Promise<string[][]>;
}

/** The records Mailivery's warmup health requires, in the order Lifty names them. */
export const WARMUP_DNS_RECORDS = ["spf", "dmarc", "mx"] as const;
export type WarmupDnsRecord = (typeof WARMUP_DNS_RECORDS)[number];
/** One bounded attempt per record, run in parallel. An unanswered lookup is unknown. */
export const WARMUP_DNS_TIMEOUT_MS = 4_000;

const nodeResolver: WarmupDnsResolver = { resolveMx, resolveTxt };
const NOT_FOUND = new Set(["ENOTFOUND", "ENODATA"]);
type Verdict = "valid" | "invalid" | "unknown";

function notFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && NOT_FOUND.has(String((error as { code: unknown }).code));
}

async function bounded<T>(timeoutMs: number, lookup: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([lookup(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}

/** NXDOMAIN/NODATA is a definite answer; any other failure or a timeout proves nothing. */
async function verdict<T>(timeoutMs: number, lookup: () => Promise<T>, valid: (answer: T) => boolean): Promise<Verdict> {
  try { return valid(await bounded(timeoutMs, lookup)) ? "valid" : "invalid"; }
  catch (error) { return notFound(error) ? "invalid" : "unknown"; }
}

const txt = (records: string[][]) => records.map(chunks => chunks.join("").trim());

/**
 * Same notion of "valid" as lift-gtm-jobs `checkDomainDns` for these three
 * records: SPF needs exactly one v=spf1 TXT record at the domain (several are a
 * permerror), DMARC needs a v=DMARC1 TXT record at _dmarc, and MX needs at
 * least one host. A Jobs warning (DMARC p=none, SPF without ~all/-all) is a
 * published record. Nothing is logged.
 */
export async function checkWarmupDns(domain: string, options: { resolver?: WarmupDnsResolver; timeoutMs?: number } = {}):
  Promise<{ invalid: WarmupDnsRecord[]; unknown: WarmupDnsRecord[] }> {
  const resolver = options.resolver ?? nodeResolver;
  const timeoutMs = options.timeoutMs ?? WARMUP_DNS_TIMEOUT_MS;
  const name = domain.trim().toLowerCase();
  const [spf, dmarc, mx] = await Promise.all([
    verdict(timeoutMs, () => resolver.resolveTxt(name), records => txt(records).filter(r => /^v=spf1(\s|$)/i.test(r)).length === 1),
    verdict(timeoutMs, () => resolver.resolveTxt(`_dmarc.${name}`), records => txt(records).some(r => /^v=DMARC1\b/i.test(r))),
    verdict(timeoutMs, () => resolver.resolveMx(name), records => records.length > 0),
  ]);
  const verdicts: Record<WarmupDnsRecord, Verdict> = { spf, dmarc, mx };
  return { invalid: WARMUP_DNS_RECORDS.filter(id => verdicts[id] === "invalid"),
    unknown: WARMUP_DNS_RECORDS.filter(id => verdicts[id] === "unknown") };
}
