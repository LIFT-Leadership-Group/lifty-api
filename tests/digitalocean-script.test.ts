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
const expectedCommit = "def4567890abcdef1234567890abcdef12345678";
const expectedRepository =
  "https://github.com/LIFT-Leadership-Group/lifty-api.git";

function runDeployPreflight(
  app: Record<string, unknown>,
  remoteCommit = expectedCommit,
) {
  const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
  const fakeDoctl = join(fakeBin, "doctl");
  const fakeGit = join(fakeBin, "git");
  const calls = join(fakeBin, "doctl-calls.log");
  writeFileSync(
    fakeDoctl,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '${JSON.stringify([app])}'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
  );
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${remoteCommit}' 'refs/heads/main'
`,
  );
  chmodSync(fakeDoctl, 0o755);
  chmodSync(fakeGit, 0o755);

  try {
    const result = spawnSync("bash", [script, "deploy", expectedCommit], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_DOCTL_CALLS: calls,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      result,
      calls: readFileSync(calls, "utf8"),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

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

  it("propagates DigitalOcean lookup failures instead of reporting a missing app", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" == "auth list" ]]; then
  exit 0
elif [[ "$1 $2" == "apps list" ]]; then
  printf '%s\\n' 'DigitalOcean API unavailable' >&2
  exit 77
fi
exit 64
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

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("DigitalOcean API unavailable");
      expect(result.stderr).not.toContain("was not found");
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
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"region":{"slug":"sfo"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
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
      expect(result.stdout).toContain(`${expectedRepository}#main`);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("reads bounded runtime logs from the resolved app and component", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const calls = join(fakeBin, "calls.log");
    writeFileSync(calls, "");
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

  it("rejects unsupported doctl flags instead of forwarding credentials or tracing", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const calls = join(fakeBin, "calls.log");
    writeFileSync(calls, "");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
exit 88
`,
    );
    chmodSync(fakeDoctl, 0o755);

    try {
      const result = spawnSync("bash", [script, "logs", "--trace"], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsupported logs option: --trace");
      expect(readFileSync(calls, "utf8")).toBe("");
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
      const curlCalls = readFileSync(calls, "utf8").trim().split("\n");
      expect(curlCalls).toHaveLength(4);
      for (const call of curlCalls) {
        expect(call).toContain("--connect-timeout 5 --max-time 20");
      }
      expect(curlCalls.join("\n")).toContain(
        "https://api.example.test/v1/workspace",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when an app-id override does not resolve to staging", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}},{"id":"prod-999","spec":{"name":"lifty-api-production"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"prod-999","spec":{"name":"lifty-api-production","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"active_deployment":{"id":"dep-prod","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          LIFTY_DO_APP_ID: "prod-999",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("does not match staging app");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when the staging app source is not the approved repository", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"https://github.com/attacker/repository.git","branch":"main"}}]},"active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("repository is not the approved staging source");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy when staging contains an unexpected component", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}},{"name":"unexpected-worker","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"active_deployment":{"id":"dep-456","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  exit 88
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
`,
    );
    chmodSync(fakeDoctl, 0o755);
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("exactly one 'api' component");
      expect(readFileSync(calls, "utf8")).not.toContain(
        "apps create-deployment",
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("refuses to deploy from a branch other than main", () => {
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-staging",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "release" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("branch is not the approved staging source");
    expect(calls).not.toContain("apps create-deployment");
  });

  it("refuses to deploy when the resolved app record is not staging", () => {
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-production",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "main" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("resolved app record is not staging");
    expect(calls).not.toContain("apps create-deployment");
  });

  it("refuses to deploy when the expected SHA is not the remote branch head", () => {
    const differentCommit = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const { result, calls } = runDeployPreflight({
      id: "app-123",
      spec: {
        name: "lifty-api-staging",
        services: [{
          name: "api",
          git: { repo_clone_url: expectedRepository, branch: "main" },
        }],
      },
      active_deployment: { id: "dep-456", phase: "ACTIVE" },
    }, differentCommit);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `remote ${expectedRepository}#main is ${differentCommit}, expected ${expectedCommit}`,
    );
    expect(calls).not.toContain("apps create-deployment");
  });

  it("deploys only the expected remote commit and verifies the active source", () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "lifty-doctl-test-"));
    const fakeDoctl = join(fakeBin, "doctl");
    const fakeCurl = join(fakeBin, "curl");
    const fakeGit = join(fakeBin, "git");
    const calls = join(fakeBin, "doctl-calls.log");
    writeFileSync(
      fakeDoctl,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCTL_CALLS"
if [[ "$1 $2" == "apps list" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging"}}]'
elif [[ "$1 $2" == "apps create-deployment" ]]; then
  printf '%s' '[{"id":"app-123","active_deployment":{"id":"dep-789","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get" ]]; then
  printf '%s' '[{"id":"app-123","spec":{"name":"lifty-api-staging","services":[{"name":"api","git":{"repo_clone_url":"${expectedRepository}","branch":"main"}}]},"region":{"slug":"sfo"},"default_ingress":"https://api.example.test","active_deployment":{"id":"dep-789","phase":"ACTIVE"}}]'
elif [[ "$1 $2" == "apps get-deployment" ]]; then
  printf '%s' '[{"id":"dep-789","phase":"ACTIVE","services":[{"name":"api","source_commit_hash":"${expectedCommit}"}]}]'
else
  printf 'unexpected doctl invocation: %s\\n' "$*" >&2
  exit 64
fi
`,
    );
    writeFileSync(
      fakeGit,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "ls-remote" && "$2" == "${expectedRepository}" && "$3" == "refs/heads/main" ]]; then
  printf '%s\\t%s\\n' '${expectedCommit}' 'refs/heads/main'
else
  printf 'unexpected git invocation: %s\\n' "$*" >&2
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
    chmodSync(fakeGit, 0o755);

    try {
      const result = spawnSync("bash", [script, "deploy", expectedCommit], {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_DOCTL_CALLS: calls,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Deployment: dep-789 (ACTIVE)");
      expect(result.stdout).toContain(`Commit: ${expectedCommit}`);
      expect(result.stdout).toContain(
        "Smoke checks passed: https://api.example.test",
      );
      const doctlCalls = readFileSync(calls, "utf8");
      expect(doctlCalls).toContain(
        "apps create-deployment app-123 --force-rebuild --wait -o json",
      );
      expect(doctlCalls).not.toContain("apps update");
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });
});
