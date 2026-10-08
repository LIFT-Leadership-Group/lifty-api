import { cpSync, rmSync } from "node:fs";

const destination = new URL("../dist/agent-context/", import.meta.url);
// Retired guides must not survive an incremental build.
rmSync(destination, { recursive: true, force: true });
cpSync(new URL("../src/agent-context/", import.meta.url), destination, { recursive: true });
cpSync(new URL("../src/favicon.ico", import.meta.url), new URL("../dist/favicon.ico", import.meta.url));
cpSync(new URL("../src/lifty-orbit-icon.png", import.meta.url), new URL("../dist/lifty-orbit-icon.png", import.meta.url));
