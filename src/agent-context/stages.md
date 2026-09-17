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

Lifty login is the stable CLI bootstrap exception: use the existing login
primitive before authenticated workspace operations. The legacy onboarding,
workspace and campaign contexts remain available for their installed flows.
The glossary is an index, not a persisted progress checklist or prerequisite
scheduler. Work on the stage the founder requested.

Start every authenticated session with `context summary` and its `get` operation.
Use the saved-state summary to choose the next stage; never restart setup from
conversation memory. Summary is read-only.

The [session summary](/v1/context/summary) is the first authenticated read.
