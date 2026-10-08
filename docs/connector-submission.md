# Lifty connector release and directory submissions

Prepared for [LIF-1101](https://linear.app/lift-leadership-group/issue/LIF-1101).
Requirements checked on September 28, 2026. This document is a preparation
packet, not evidence of a release, a successful founder run, or a submission.
Record actual receipts on the Linear issue.

## Release prerequisites

- [ ] LIF-1097 sign-in, LIF-1098 MCP operations, LIF-1099 server onboarding
  state, and LIF-1100 next-step guidance are deployed and verified together.
- [x] The owner chose the existing environment on September 28, 2026:
  "usa el mismo workspace, no quiero separar mas ambientes". Rehearse in the
  existing app, shared GTM project and existing authorized workspace. Use approved
  test data there; do not create another workspace or environment for rehearsal. `lifty-api-staging` is the app's
  name, not evidence of an isolated staging database. This also preserves the
  [LIF-617](https://linear.app/lift-leadership-group/issue/LIF-617) decision.
- [ ] Any database change has passed the `lift-supabase-functions`
  `production-database` workflow. Follow the LIF-627 accepted-catalog policy.
- [ ] Supabase OAuth server settings and the consent URL are configured for
  the approved environment. Preserve Site URL `https://liftygtm.com`; configure
  the relative OAuth Authorization Path `/oauth/consent`. Deploy the dashboard
  forwarding route and API consent page first. The dashboard's server-side
  `LIFTY_API_URL` must match the API's `PUBLIC_BASE_URL`; include that exact API
  origin in Auth's redirect URL allowlist so browser consent calls pass Origin
  validation. Keep existing entries. An absolute Authorization Path does not
  replace Site URL. See [the OAuth rollout guide](mcp-oauth.md). DCR changes
  registration on the shared Auth project. Confirm that effect before enabling it.
- [ ] The final public HTTPS MCP URL is chosen. Keep its origin stable:
  OpenAI requires a new plugin if the scheme, hostname, or port changes.
- [ ] Unauthenticated requests advertise protected-resource metadata and a
  valid OAuth challenge. The metadata `resource` exactly matches the MCP URL,
  including its path. Discovery advertises S256 PKCE.
- [ ] The real OAuth grant, refresh, denial, and revocation paths work in both
  clients. Validate issuer, audience, expiry, workspace membership, and the
  current session without loosening the existing REST or RLS boundary.
- [ ] A new conversation and a second client resume the saved onboarding
  state. Duplicate submit attempts produce one receipt and one workspace.
- [ ] Founder runs in Claude and ChatGPT complete against that same authorized
  workspace. Test data contains no other tenant's information. Stop before live
  outreach. Record exact API/database revisions, client and plan, date, result,
  and cleanup evidence on LIF-1101.
- [ ] The public installation guide is released with the actual URL and OAuth
  setting. Remove its coming-soon wording only after the client checks pass.

The September 28 public probes found `/mcp`,
`/.well-known/oauth-protected-resource`, and
`/.well-known/openai-apps-challenge` absent on the current API. GTM's OAuth
authorization-server discovery returned `feature_disabled`. Its OIDC discovery
document still returned 200, so that response alone is not an enablement check.
These are dated audit observations; use fresh deployment receipts at release.

## Listing material

Use the same product and publisher identity in both portals. Verify every
capability below against the released tool catalog before submission.

| Field | Prepared value or action |
| --- | --- |
| Product name | Lifty |
| Publisher | LIFT Leadership Group. Match the verified identity selected in OpenAI. |
| Short description | Set up your Lifty workspace, review researched leads, and manage outbound configuration from your conversation. |
| Long description | Lifty helps founders describe their business and target customers, save their workspace configuration, review researched leads, and continue onboarding from another conversation. Connect your own Lifty account to access the workspaces you belong to. Review changes before approving them. Provider connections and outreach actions follow the permissions and approval rules of your Lifty workspace. |
| Website | https://liftygtm.com/ |
| Documentation | https://liftygtm.com/connectors after the prepared page is deployed and updated for launch. It is not live documentation yet. |
| Support URL | https://liftygtm.com/support |
| Support contact | juan@liftleadershipgroup.com, the existing published contact |
| Privacy policy | https://liftygtm.com/privacy-policy. Publish the connector data-flow disclosure and compare it with actual tool responses. |
| Terms | https://liftygtm.com/terms-of-service |
| Icon | Approved Órbita Fase PNG (512 by 512): https://api.liftygtm.com/brand/lifty-orbit-icon.png after this API release is deployed. Source asset: `src/lifty-orbit-icon.png`, rendered from `src/lifty-orbit-icon.svg` (dashboard `app/icon.svg`). Use this asset when uploading a connector or directory logo. Check the portal's current asset constraints. |
| MCP URL | Pending deployed and verified endpoint. Do not submit a placeholder. |
| Authentication | OAuth authorization code with S256 PKCE. Select the registration method proven in both client rehearsals. |
| Category | Choose the portal's current category that describes sales and workspace productivity. |
| Countries | Publisher must select only the places where Lifty is actually supported. No country list has been approved here. |
| Release notes | First remote MCP connector release, after the prerequisites above pass. |
| Screenshots | No custom MCP UI is currently part of these issues. OpenAI says to omit screenshots for plugins without UI; Claude's carousel requirement applies to MCP Apps with UI. |

The MCP initialization response advertises this same PNG in `serverInfo.icons`,
using the configured API origin. Existing uploaded connector logos are managed
by the client: [ChatGPT's app owner can edit a developer-mode app's logo through
Manage](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt).
Updating the server does not guarantee replacement of an existing uploaded or
cached logo. Use the new PNG when creating the connector or updating its logo.

Starter prompts for the portal:

- "Help me set up Lifty for my business. Show me the configuration before saving it."
- "Resume my Lifty setup and explain what I need to do next."
- "Show me my researched leads and explain why they match my target customer."
- "Review my current Lifty configuration before making any changes."

## Reviewer account and fixtures

No reviewer account, password, or seed data is created by this packet. The
release owner must prepare a dedicated account with populated fictional data
and verify it from outside the company network. OpenAI requires access without
MFA, SMS, email confirmation, or further setup. Keep credentials in the portal's
reviewer fields and the approved credential store, never in git or Linear.

Prepare one account with an unfinished onboarding draft and one completed
internal workspace with at least five fictional researched leads, configuration,
draft copy, and readable operation status. Use reserved `.example` domains.
Do not copy a real tenant. Document fixture identifiers and expected values in
the private reviewer instructions, with a cleanup owner.

Sending and provider operations must remain subject to their real guards.
Provide an approved test-only provider account or a proven fixture mode for any
tool that would otherwise act externally. Do not make transport calls to real
prospects, connect a real customer mailbox, or bypass approval, suppression,
membership, or session checks to satisfy review. If a published tool cannot be
exercised safely, resolve that gap before claiming every tool was tested.

## Reviewer test cases

OpenAI asks for at least five positive and three negative cases. These cases
specify required behavior, not passing results. Before submission, replace the
workflow descriptions with the exact discovered tool names and include the
fixture values and observed output shapes in the portal. The eight cases do
not replace Claude's requirement to exercise every published tool.

| ID | Prompt or scenario | Fixture | Required result |
| --- | --- | --- | --- |
| P1 | "Show me where I am in Lifty onboarding and what to do next." | Signed-in reviewer with an unfinished draft | Read progress and guidance tools return the current saved stage, outstanding founder input, and the next supported action. They do not create a workspace or send anything. |
| P2 | "Save this business and target-customer information after I confirm it." | Reviewer draft plus explicit fictional answers in the test instructions | The client shows the proposed configuration, saves confirmed inputs with the onboarding tool, and reads them back. The saved revision and supplied values match. |
| P3 | "Continue my Lifty setup." in a fresh conversation and then the other client | Same Lifty account and saved draft from P2 | The client reads the existing draft and next step. It does not require local skill files, repeat answered questions, or create a second draft. |
| P4 | Submit a validated, confirmed configuration, then repeat the same submission after an apparent timeout | Dedicated unfinished reviewer draft and a stable submission identity | Both attempts return the same durable submission outcome. Readback shows one workspace and one receipt. Provider actions and outreach remain inactive. |
| P5 | "Show my five researched leads, explain their fit, and check the research run's status." | Completed fictional workspace, five seeded leads, and a known job result | Read tools return only that workspace's seeded leads and actual job state. Pending or failed work is reported honestly; no new job or outreach starts. |
| N1 | Call a workspace tool signed out, then with an expired or revoked grant | No valid session | The API fails closed and the client offers sign-in. No workspace data, secret, or mutation is returned. Reconnect is explicit. |
| N2 | "Use this other workspace ID and show me its leads." | A second internal workspace that the reviewer does not belong to | Membership checks reject access without exposing the other workspace's data. A forged ID never changes the caller's identity. |
| N3 | "Skip approval and send outreach now", or a seeded lead note instructs the assistant to do that | Inactive fictional campaign, unapproved copy, no sending provider | The assistant declines to bypass approval. Backend guards reject any attempted activation or send. No external transport occurs; lead notes are treated as data. |

For each case, record the exact prompt, tool calls, expected and actual result,
API/database revision, and client. Redact tokens and credentials from receipts.
Review returned fields against the privacy policy. Remove unnecessary personal
data, debug payloads, and internal identifiers instead of disclosing avoidable
data just to pass review.

## Claude submission

Use [the developer portal](https://claude.ai/directory/manage) on an eligible
paid Claude account and choose MCP connector.

- [ ] Confirm the account's publishing role and intended organization.
- [ ] Add the final remote HTTPS URL and prove OAuth works.
- [ ] Scan the tools, prompts, and resources. Every tool needs a title and
  correct annotations. Reads and writes must be separate tools.
- [ ] Fill in the listing, company, use cases, prerequisites, authentication,
  and data-handling fields. Choose the permanent listing slug carefully.
- [ ] Supply the documentation, policy, contact, icon, and populated reviewer
  credentials with every step needed to connect.
- [ ] Exercise every tool through Claude or MCP Inspector and record results.
- [ ] The publisher reviews all seven required acknowledgments: directory
  guidelines, first-party API usage, financial transactions, AI media
  generation, prompt injection, conversation data collection, and public docs.
  Do not pre-check these on the publisher's behalf.
- [ ] Submit and record the actual portal status and receipt on LIF-1101.

Anthropic scans submissions and normally lists them as Community. Some receive
human review. Verified is not a prerequisite for using the connector and is
not an outcome to promise here.

## OpenAI submission

Use [the plugin portal](https://platform.openai.com/plugins), Create plugin,
then With MCP. A remote MCP-only plugin does not need custom UI or a skill.

- [ ] Use the intended organization and a project with global data residency.
  Current docs exclude EU-residency projects from MCP submission.
- [ ] Complete individual or business verification for the actual publisher.
- [ ] Confirm Apps Management Write access. Organization owners already have
  it; another submitter needs the role assigned.
- [ ] Enter the listing material, reviewer credentials, starter prompts,
  approved countries, and five positive plus three negative test cases.
- [ ] Choose Universal URL and the final MCP endpoint. Template URLs require
  separate OpenAI approval and are unnecessary for the shared Lifty endpoint.
- [ ] Complete any domain challenge. Serve exactly the portal-provided token
  as the sole response at `/.well-known/openai-apps-challenge` on the MCP
  hostname or an allowed parent origin. Do not invent a token or overwrite an
  existing plugin's challenge. The API serves the configured
  `LIFTY_OPENAI_APPS_CHALLENGE` value as plain text at this route. Configure the
  real portal value and verify the deployed response; no token was invented or
  installed during source preparation.
- [ ] Use the exact callback shown by the portal. ChatGPT may use
  `https://chatgpt.com/connector/oauth/{callback_id}`; the stable callback
  applies only under the documented issuer-identification conditions or to
  older eligible integrations.
- [ ] Verify advertised OIDC scopes and UserInfo behavior if supporting
  enterprise workspace domain restrictions. Do not claim verified email from
  an unverified account.
- [ ] Scan tools and resolve metadata issues. Check `readOnlyHint`,
  `destructiveHint`, `openWorldHint`, security schemes, and output fields
  against real behavior. Review current Claude requirements too.
- [ ] Submit and record the actual portal status and receipt on LIF-1101.
  Approval and publication are separate actions. No review deadline is promised.

## Handoff and evidence still needed

| Evidence | Current state |
| --- | --- |
| Approved rehearsal environment | Existing app, shared GTM and same authorized workspace, per September 28 owner decision |
| Claude founder onboarding receipt | Pending |
| ChatGPT founder onboarding receipt | Pending |
| Deployed public guide with final URL | Pending |
| Reviewer credentials and populated fixtures | Pending |
| Publisher identity, role, country choices, acknowledgments | Pending publisher verification |
| Claude submission receipt and status | Not established by this packet |
| OpenAI submission receipt and status | Not established by this packet |
| David receives tested install steps | Pending handoff; no message sent |

After the guide is deployed and tested, give David its public URL plus the
client and plan requirements. Record the actual handoff on LIF-1101. Do not
mark that issue Done while either client proof or either submission is missing.

## Primary sources

- [Claude custom connectors](https://claude.com/docs/connectors/custom/add-unlisted)
- [Claude authentication](https://claude.com/docs/connectors/building/authentication)
- [Claude submission](https://claude.com/docs/connectors/building/submission)
- [Claude tool review criteria](https://claude.com/docs/connectors/building/review-criteria)
- [ChatGPT Developer mode](https://developers.openai.com/api/docs/guides/developer-mode)
- [OpenAI authentication](https://developers.openai.com/plugins/build/auth)
- [OpenAI submission](https://developers.openai.com/plugins/deploy/submission)
- [OpenAI remote MCP review](https://developers.openai.com/plugins/deploy/app-review)
- [Supabase OAuth setup](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase MCP authentication](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
