import { cpSync } from "node:fs";

cpSync(new URL("../src/agent-context/", import.meta.url),
  new URL("../dist/agent-context/", import.meta.url), { recursive: true });
