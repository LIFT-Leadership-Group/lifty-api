import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  buildCrmPropertyPayload,
  buildScoutResearchSchema,
  canonicalizeScoutContract,
} from "../src/generated/crm-shared/index.js";
import { CRM_FIELD_MAPPING_CONFORMANCE_FIXTURES } from "../src/generated/crm-shared/conformance-fixtures.js";
import type {
  BuildCrmPropertyPayloadInput,
  BuildScoutResearchSchemaInput,
} from "../src/generated/crm-shared/types.js";
import type { CanonicalizeScoutContractInput } from "../src/generated/crm-shared/scout-contract.js";
for (const fixture of CRM_FIELD_MAPPING_CONFORMANCE_FIXTURES) {
  it(`shared product mapper conformance: ${fixture.name}`, () => {
    if (fixture.kind === "payload")
      expect(
        buildCrmPropertyPayload(
          structuredClone(fixture.input) as BuildCrmPropertyPayloadInput,
        ),
      ).toEqual(fixture.expected);
    else {
      expect(
        buildScoutResearchSchema(
          structuredClone(fixture.schemaInput) as BuildScoutResearchSchemaInput,
        ),
      ).toEqual(fixture.expectedSchema);
      for (const input of fixture.canonicalInputs) {
        const result = canonicalizeScoutContract(
          structuredClone(input) as CanonicalizeScoutContractInput,
        );
        expect(result.canonical).toEqual(fixture.expectedCanonical);
        expect(result.hash).toBe(fixture.expectedHash);
      }
    }
  });
}
it("generated modules match recorded source distribution hashes", () => {
  const rows: {
    target: string;
    generated_sha256: string;
    source_commit: string;
  }[] = JSON.parse(
    readFileSync(
      new URL("../src/generated/crm-contract.manifest.json", import.meta.url),
      "utf8",
    ),
  );
  for (const row of rows) {
    expect(row.source_commit).toMatch(/^[a-f0-9]{40}$/);
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(`../${row.target}`, import.meta.url)))
        .digest("hex"),
    ).toBe(row.generated_sha256);
  }
});
