import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
// Import the phrase matcher Jobs runs on composed copy. The phrases themselves
// are data (outreach_rulebooks key anti_slop) and are read live; only the code
// that parses and matches them is copied, so both sides judge text the same way.
const source = process.argv[2];
if (!source)
  throw new Error(
    "Usage: node scripts/sync-writing-rules.mjs <lift-gtm-jobs-checkout>",
  );
const from = "src/lib/outreach-rulebook/anti-slop.ts";
const to = "src/generated/anti-slop.ts";
const sourceCommit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const original = readFileSync(resolve(source, from), "utf8");
const content =
  "// Generated from lift-gtm-jobs/" +
  from +
  "; regenerate with scripts/sync-writing-rules.mjs.\n" +
  original;
mkdirSync(dirname(to), { recursive: true });
writeFileSync(to, content);
writeFileSync(
  "src/generated/anti-slop.manifest.json",
  JSON.stringify(
    [
      {
        source_commit: sourceCommit,
        source: from,
        target: to,
        source_sha256: createHash("sha256").update(original).digest("hex"),
        generated_sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
    null,
    2,
  ) + "\n",
);
