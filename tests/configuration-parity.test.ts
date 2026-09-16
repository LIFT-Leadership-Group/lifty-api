import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { it } from "vitest";
import { lintLocalOnboardingConfiguration, lintLocalConfigUpdateConfiguration } from "../src/generated/lifty-configuration.js";
const fixtures = JSON.parse(readFileSync(new URL("./lifty-configuration.fixtures.json", import.meta.url), "utf8")) as Array<{ name:string; kind?:string; desiredIcp?:Record<string,unknown>; configuration:unknown; draft:Record<string,unknown>; base:string; code:string|null }>;
for (const f of fixtures) it(`canonical parity: ${f.name}`, () => {
 const result=f.kind === "update" ? lintLocalConfigUpdateConfiguration(f.configuration,f.desiredIcp ?? {},f.base) : lintLocalOnboardingConfiguration(f.configuration,f.draft,f.base);
 assert.equal(result.success,f.code===null);
 if(!result.success) assert.ok(result.issues.some(issue=>issue.code===f.code));
});
it("generated contract content matches its canonical source hash",()=>{
 const text=readFileSync(new URL("../src/generated/lifty-configuration.ts",import.meta.url),"utf8");
 const lines=text.split("\n");const expected=lines[1]?.split(": ")[1];
 assert.equal(createHash("sha256").update(lines.slice(2).join("\n")).digest("hex"),expected);
});
