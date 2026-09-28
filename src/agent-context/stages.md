# Workspace stages

Fetch fresh context for the relevant stage before preparing a request. Each
response contains its Markdown guide and current operation routes, input
schemas and response schemas. Private saved values come only from the
authenticated read operations published by each stage, never from this index
or shared context.

| Stage | Context | Use it for |
| --- | --- | --- |
| Business | [business](/v1/context/business) | Workspace name, description and first provisioning |
| Targeting / ICP | [targeting](/v1/context/targeting) | Buyers, companies, geography and personas |
| Research criteria | [research-criteria](/v1/context/research-criteria) | Evidence, exclusions and research instructions |
| Sample review | [sample-review](/v1/context/sample-review) | Existing cohort, grades and calibration |
| Commercial voice | [commercial-voice](/v1/context/commercial-voice) | The customer's commercial tone and proposition |
| CRM | [crm](/v1/context/crm) | HubSpot authorization, full CRM mapping, verified record links and field updates |
| Sending accounts | [sending-accounts](/v1/context/sending-accounts) | Hosted LinkedIn and email authorization |
| Campaigns | [campaigns](/v1/context/campaigns) | Workspace sequence setup, preview and automatic outreach activation |
| Notifications | [notifications](/v1/context/notifications) | Slack authorization, destinations and routing |
| Capacity | [capacity](/v1/context/capacity) | Read-only operating target and discovery allowance |

Sign in through the current client before private reads. Start onboarding with
`next_step`, also available as the summary stage's `next_step` operation. It
reads saved interview, import and research state and returns the current guide.
It never starts work, confirms founder acceptance or activates sending.

For an existing workspace task, begin with `summary.get`, then read the guide
for the requested stage. A failed read is unknown, not missing setup. The
founder's requested task may proceed independently of pending calibration when
its own prerequisites are satisfied.

The [session summary](/v1/context/summary) describes the existing-workspace read.
