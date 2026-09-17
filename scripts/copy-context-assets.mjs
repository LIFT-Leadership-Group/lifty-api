import { cpSync, rmSync } from "node:fs";

const destination = new URL("../dist/agent-context/", import.meta.url);
// Retired guides must not survive an incremental build.
rmSync(destination, { recursive: true, force: true });
cpSync(new URL("../src/agent-context/", import.meta.url), destination, { recursive: true });
