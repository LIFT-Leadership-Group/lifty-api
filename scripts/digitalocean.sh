#!/usr/bin/env bash

set -euo pipefail
umask 077

APP_NAME="${LIFTY_DO_APP_NAME:-lifty-api-staging}"
COMPONENT="${LIFTY_DO_COMPONENT:-api}"

fail() {
  printf 'digitalocean: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required"
}

resolve_app_id() {
  if [[ -n "${LIFTY_DO_APP_ID:-}" ]]; then
    printf '%s\n' "$LIFTY_DO_APP_ID"
    return
  fi

  local matches
  matches="$({ doctl apps list -o json | jq -r --arg name "$APP_NAME" \
    '.[] | select(.spec.name == $name) | .id'; } || true)"
  [[ -n "$matches" ]] || fail "app '$APP_NAME' was not found"
  [[ "$matches" != *$'\n'* ]] || fail "more than one app is named '$APP_NAME'"
  printf '%s\n' "$matches"
}

show_status() {
  require_command doctl
  require_command jq

  local app_id app_json deployment_id deployment_json
  app_id="$(resolve_app_id)"
  app_json="$(doctl apps get "$app_id" -o json)"
  deployment_id="$(jq -er '.[0].active_deployment.id' <<<"$app_json")"
  deployment_json="$(doctl apps get-deployment "$app_id" "$deployment_id" -o json)"

  jq -r --arg component "$COMPONENT" '
    .[0] |
    "App: \(.spec.name) (\(.id))",
    "Region: \(.region.slug)",
    "Ingress: \(.default_ingress)",
    "Deployment: \(.active_deployment.id) (\(.active_deployment.phase))",
    (.spec.services[] | select(.name == $component) |
      "Source: \(.git.repo_clone_url // ("https://github.com/" + .github.repo))#\(.git.branch // .github.branch)")
  ' <<<"$app_json"
  jq -r --arg component "$COMPONENT" '
    .[0].services[] | select(.name == $component) |
    "Commit: \(.source_commit_hash // "unknown")"
  ' <<<"$deployment_json"
}

show_logs() {
  require_command doctl
  require_command jq

  local app_id log_type="run" tail_lines="100"
  local -a passthrough=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)
        [[ $# -ge 2 ]] || fail "--type requires a value"
        log_type="$2"
        shift 2
        ;;
      --type=*)
        log_type="${1#*=}"
        shift
        ;;
      --tail)
        [[ $# -ge 2 ]] || fail "--tail requires a value"
        tail_lines="$2"
        shift 2
        ;;
      --tail=*)
        tail_lines="${1#*=}"
        shift
        ;;
      *)
        passthrough+=("$1")
        shift
        ;;
    esac
  done

  app_id="$(resolve_app_id)"
  if [[ ${#passthrough[@]} -gt 0 ]]; then
    doctl apps logs "$app_id" "$COMPONENT" \
      --type "$log_type" --tail "$tail_lines" --no-prefix "${passthrough[@]}"
  else
    doctl apps logs "$app_id" "$COMPONENT" \
      --type "$log_type" --tail "$tail_lines" --no-prefix
  fi
}

run_smoke() {
  require_command curl
  require_command doctl
  require_command jq

  local app_id app_json ingress smoke_dir auth_body auth_status
  app_id="$(resolve_app_id)"
  app_json="$(doctl apps get "$app_id" -o json)"
  ingress="$(jq -er '.[0].default_ingress' <<<"$app_json")"
  ingress="${ingress%/}"
  smoke_dir="$(mktemp -d "${TMPDIR:-/tmp}/lifty-do-smoke.XXXXXX")"
  auth_body="$smoke_dir/unauthorized.json"
  trap 'rm -rf -- "$smoke_dir"' EXIT

  curl --fail --silent --show-error "$ingress/healthz" \
    | jq -e '.status == "ok"' >/dev/null
  curl --fail --silent --show-error "$ingress/readyz" \
    | jq -e '.status == "ready"' >/dev/null
  curl --fail --silent --show-error "$ingress/openapi.json" \
    | jq -e '.openapi == "3.1.0"' >/dev/null

  auth_status="$(curl --silent --show-error \
    --output "$auth_body" --write-out '%{http_code}' \
    "$ingress/v1/workspace")"
  [[ "$auth_status" == "401" ]] \
    || fail "unauthenticated /v1/workspace returned HTTP $auth_status, expected 401"
  jq -e '.error.code == "UNAUTHORIZED"' "$auth_body" >/dev/null \
    || fail "unauthenticated response did not use the UNAUTHORIZED envelope"

  rm -rf -- "$smoke_dir"
  trap - EXIT
  printf 'Smoke checks passed: %s\n' "$ingress"
}

deploy_app() {
  require_command doctl
  require_command jq

  local app_id deploy_dir spec_file
  app_id="$(resolve_app_id)"
  deploy_dir="$(mktemp -d "${TMPDIR:-/tmp}/lifty-do-deploy.XXXXXX")"
  spec_file="$deploy_dir/app-spec.json"
  trap 'rm -rf -- "$deploy_dir"' EXIT

  doctl apps spec get "$app_id" --format json >"$spec_file"
  doctl apps update "$app_id" --spec "$spec_file" \
    --update-sources --wait -o json >/dev/null

  rm -rf -- "$deploy_dir"
  trap - EXIT
  show_status
  run_smoke
}

run_doctor() {
  require_command curl
  require_command doctl
  require_command jq

  doctl auth list >/dev/null
  local app_id
  app_id="$(resolve_app_id)"
  printf 'DigitalOcean access ready: %s\n' "$app_id"
}

usage() {
  cat <<'EOF'
Usage: scripts/digitalocean.sh <command> [options]

Commands:
  doctor             Check local tooling, authentication, and app access
  status             Show the app, deployment, source commit, and ingress
  logs [options]     Read runtime logs (accepts doctl apps logs options)
  deploy             Deploy the latest configured source and run smoke checks
  smoke              Probe health, readiness, OpenAPI, and fail-closed auth
  help                Show this help

Environment:
  LIFTY_DO_APP_NAME   App name to resolve (default: lifty-api-staging)
  LIFTY_DO_APP_ID     Optional exact app ID; skips name resolution
  LIFTY_DO_COMPONENT Component name (default: api)
EOF
}

case "${1:-help}" in
  help|-h|--help)
    usage
    ;;
  status)
    show_status
    ;;
  doctor)
    run_doctor
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  smoke)
    run_smoke
    ;;
  deploy)
    deploy_app
    ;;
  *)
    printf 'Command not implemented yet: %s\n' "$1" >&2
    exit 2
    ;;
esac
