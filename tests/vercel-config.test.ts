import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Vercel staging configuration", () => {
  it("keeps compiled service code out of the static output", async () => {
    const config = JSON.parse(
      await readFile(new URL("../vercel.json", import.meta.url), "utf8"),
    ) as {
      outputDirectory?: string;
      rewrites?: Array<{ source: string; destination: string }>;
    };

    expect(config.outputDirectory).toBe("public");
    expect(config.outputDirectory).not.toBe("dist");
    expect(config.rewrites).toEqual([
      { source: "/(.*)", destination: "/api" },
    ]);

    const robots = await readFile(
      new URL("../public/robots.txt", import.meta.url),
      "utf8",
    );
    expect(robots).toBe("User-agent: *\nDisallow: /\n");
  });
});
