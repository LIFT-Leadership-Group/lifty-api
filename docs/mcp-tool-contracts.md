# MCP tool effects and review annotations

Tool descriptions and hints must describe the complete operation, including
defaults and downstream work. A successful save can confirm configuration or
accepted work without proving that research, compilation, CRM delivery or
outreach completed. Authentication, workspace membership, version checks and
saved Campaign approvals remain enforced by their owning handlers.

The [OpenAI annotation rules](https://developers.openai.com/plugins/plugin-guidelines#correct-annotation)
require explicit `readOnlyHint`, `destructiveHint` and `openWorldHint` values.
Private revision history does not make replacing an effective resource additive.
A bounded connected CRM account is private scope; public prospect acquisition
and contact with external recipients are open-world effects.

## Audited operation contracts

Tuple order is read-only / destructive / open-world. The hints below describe
the requested business operation. The current generator already supplies these
tuples; the corrections concern descriptions and the research target schema.

| Tool | Hints | Complete requested effect |
| --- | --- | --- |
| `targeting_patch` | false / true / false | Changes effective private search lanes; can remove lanes and replace criteria transactionally. |
| `setup_patch_draft` | false / true / false | Replaces the complete effective setup draft and generated criteria, retaining prior revisions. |
| `sample_review_progress` | true / false / false | Bounded, authenticated polling of one saved run and its existing cohort. |
| `sample_review_get` | true / false / false | Reads the saved current sample, grades, state and review marker. |
| `sample_review_post` | false / true / true | Queues prospect discovery/research, reattaches active work or retries an incomplete failed sample. |
| `research_schedule_patch` | false / true / false | Replaces the effective weekly target; does not activate research. |
| `research_schedule_activate` | false / true / true | Saves active research intent; later scheduled cycles acquire and research public prospects. |
| `leads_list` | true / false / false | Lists existing tenant research results; does not acquire or enrich leads. |
| `crm_sync_start` | false / true / false | Queues creation/update of eligible saved leads in the connected CRM and configured research mirrors. |
| `crm_mapping_sources` | true / false / false | Reads saved evidence for the explicit tenant-owned cohort. |
| `crm_mapping_preview` | true / false / false | Computes proposed mapping values against existing records in the connected CRM. |
| `crm_mapping_sync` | false / true / false | Queues bounded existing-record updates; approved write policies can overwrite populated fields. |
| `journeys_activate` | false / true / true | Selects an approved revision for new starts; active Campaigns can subsequently contact recipients. |
| `campaigns_activate` | false / true / true | Selects an approved revision and active intent, or resumes retained work that can contact recipients. |
| `campaigns_post` | false / false / false | Adds an inactive, unapproved private Campaign draft. |
| `campaigns_draft_patch` | false / true / false | Replaces the effective unapproved draft and refreshes default Business/current sender revision pins. |

## Description and schema boundaries

- Setup draft saves require the complete `draft`. `generated_criteria: null`
  clears the effective criteria; this is not a partial-field patch.
- Sample starts return accepted/queued work. Use progress or sample reads to
  verify completion; reattachment and incomplete failed-run retry are distinct.
- New CRM sync cohorts contain at most 2,000 eligible saved leads. Active runs
  reattach and failed runs retry their saved cohort. Mapping replay accepts at
  most 25 explicit leads and reuses the exact receipt for an identical
  `request_ref`; it does not create records.
- Campaign draft edits use current confirmed `profile_version` and
  `voice_version` when those fields are omitted, and pin current permitted
  sender revisions. Existing approved execution remains pinned.
- Journey and Campaign activation receipts confirm saved selection/intent.
  Scheduled execution can contact external recipients after the existing
  readiness, account, customer-list and incident gates permit it.
- The research target RPC accepts one-to-nine-digit positive integers before
  checking the workspace's plan limit. The API maximum is therefore
  `999999999`, not the wider PostgreSQL integer bound; `null` still follows the
  plan's full limit.

## Provider-session maintenance boundary

Mapping previews do not save mappings, enqueue delivery or write CRM records.
Their shared provider transport can refresh existing OAuth credentials and mark
an invalid connection as needing reconnect. The preview hint treats that as
existing-session maintenance, rather than a requested business mutation. The
strict wording of OpenAI's no-environment-mutation rule leaves this interpretation
unconfirmed. It must not be represented as OpenAI approval or proof that this
transport is persistence-free. See [transport.ts](../src/crm-mapping/transport.ts).

## Source and verification

Operation owners are [business-operations.ts](../src/business-operations.ts),
[research-operations.ts](../src/research-operations.ts),
[outreach-operations.ts](../src/outreach-operations.ts),
[stage-contracts.ts](../src/stage-contracts.ts) and
[mcp-stage-tools.ts](../src/mcp-stage-tools.ts).

The backing Functions migrations are
`20261002120000_lif1173_business_resources.sql`,
`20261002131000_lif1174_research_schedule.sql`,
`20261002132000_lif1174_runs_and_outreach_gate.sql`,
`20261004110000_lif1188_outreach_operations.sql`,
`20261005234000_lif1247_full_plan_target.sql`,
`20261006150000_lif1238_attio_self_service.sql` and
`20261008090000_lif1128_activation_hold.sql`. Scheduled work is owned by Jobs'
`lifty-first-run`, `lifty-crm-sync`, `lifty-crm-mapping-sync` and
`lifty-workspace-outreach` tasks. Source inspection does not prove a sibling
revision is deployed.

Existing MCP catalog/HTTP tests protect schemas, annotations, authentication
and dispatch. The research invalid-input table rejects a ten-digit target
before an RPC. Run `npm run verify` before releasing changes. A generic scan
finding requiring further review does not identify a particular failed rule;
only a fresh scan of the deployed definitions can show its next result.
