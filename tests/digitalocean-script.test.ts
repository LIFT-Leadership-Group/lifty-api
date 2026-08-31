import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const script = new URL("../scripts/digitalocean.sh", import.meta.url).pathname;

describe("DigitalOcean operations script", () => {
  it("documents the complete agent-facing command surface without requiring credentials", () => {
    const result = spawnSync("bash", [script, "help"], { encoding: "utf8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("logs");
    expect(result.stdout).toContain("deploy");
    expect(result.stdout).toContain("smoke");
  });

  it("checks the local tools, authentication, and target app before operations", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth list" ]]; then
  printf '%s\\n' 'default (current)'
elif [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "doctor"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("DigitalOcean access ready: app-123");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("resolves the app by name and reports the exact active source", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"https://github.com/example/lifty-api.git","branch":"main"}}]},"region":{"slug":"sfo"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get-deployment" ]]; then
  printf '%s' '[{"id":"dep-456","phase":"ACTIVE","services":[{"name":"api","source_commit_hash":"abc123"}]}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "status"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("lifty-api-staging (app-123)");
      expect(result.stdout).toContain("dep-456 (ACTIVE)");
      expect(result.stdout).toContain("abc123");
      expect(result.stdout).toContain("https://api.example.test");
      expect(result.stdout).toContain("https://github.com/example/lifty-api.git#main");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("reads bounded runtime logs from the resolved app and component", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const calls = join(fakeBin, "calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps logs" ]]; then
  printf '%s\\n' '{"event":"request_failed","request_id":"safe-id"}'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "logs", "--tail", "12"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"event":"request_failed"');
      expect(readFileSync(calls, "utf8")).toContain(
        "apps logs app-123 api --type run --tail 12 --no-prefix",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("smoke-checks public routes and verifies authentication fails closed", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const calls = join(fakeBin, "curl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_CURL_CALLS"
url="\${!#}"
case "$url" in
  */healthz) printf '%s' '{"status":"ok"}' ;;
  */readyz) printf '%s' '{"status":"ready"}' ;;
  */openapi.json) printf '%s' '{"openapi":"3.1.0"}' ;;
  */v1/workspace)
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' '{"error":{"code":"UNAUTHORIZED"}}' > "$output"
    printf '401'
    ;;
  *) exit 22 ;;
esac
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeCurl, 0o755);

    try {
      const result = spawnSync("bash", [script, "smoke"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_CURL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Smoke checks passed: https://api.example.test",
      );
      expect(readFileSync(calls, "utf8")).toContain(
        "https://api.example.test/v1/workspace",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("deploys updated sources with the remote spec and verifies the result", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2 $3" == "apps spec get" ]]; then
  printf '%s' '{"name":"lifty-api-staging","services":[{"name":"api","envs":[{"key":"SUPABASE_PUBLISHABLE_KEY","type":"SECRET","value":"EV[encrypted:example]"}]}]}'
elif [[ "$1 $2" == "apps update" ]]; then
  spec=''
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--spec" ]]; then spec="$2"; shift 2; else shift; fi
  done
  grep -q 'EV\\[encrypted:example\\]' "$spec"
  printf '%s' '[{"id":"app-123","active_deployment":{"id":"dep-789","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"https://github.com/example/lifty-api.git","branch":"main"}}]},"region":{"slug":"sfo"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-789","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get-deployment" ]]; then
  printf '%s' '[{"id":"dep-789","phase":"ACTIVE","services":[{"name":"api","source_commit_hash":"def456"}]}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeCurl,
      `#!/usr/bin/env bash
set -euo pipefail
url="\${!#}"
case "$url" in
  */healthz) printf '%s' '{"status":"ok"}' ;;
  */readyz) printf '%s' '{"status":"ready"}' ;;
  */openapi.json) printf '%s' '{"openapi":"3.1.0"}' ;;
  */v1/workspace)
    output=''
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--output" ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' '{"error":{"code":"UNAUTHORIZED"}}' > "$output"
    printf '401'
    ;;
  *) exit 22 ;;
esac
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeCurl, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Deployment: dep-789 (ACTIVE)");
      expect(result.stdout).toContain("Commit: def456");
      expect(result.stdout).toContain(
        "Smoke checks passed: https://api.example.test",
      );
      const doctlCalls = readFileSync(calls, "utf8");
      expect(doctlCalls).toContain("apps spec get app-123 --format json");
      expect(doctlCalls).toContain("apps update app-123 --spec");
      expect(doctlCalls).toContain("--update-sources --wait -o json");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
