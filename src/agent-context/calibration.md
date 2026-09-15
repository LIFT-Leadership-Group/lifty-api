# Review targeting before connecting outreach

Apply this workflow after the initial lead run and after every targeting or
research-criteria change. The comparison sample is five researched **Tier A**
leads under the current confirmed ICP, each with its actual LinkedIn profile URL
and a concrete fit rationale. Five researched candidates of mixed tiers are not
a completed sample.

1. Wait for the targeting update to finish, then run `lifty run`. The service
   researches candidates and fills missing sample places with bounded discovery
   waves, keeping the existing Apollo allowance. Before new discovery, read
   `lifty get allowance --workspace <workspace-id>`. A completed sample may be
   shown again without acquiring more leads.
2. Present the Tier A sample as a table: person, company, **LinkedIn profile
   URL**, and why this lead qualifies. Use the returned `linkedin_url`, never
   invent or guess a profile. Research/dashboard links are optional additional
   links and never replace the LinkedIn URL. Preserve every verdict and the
   reported discovery/research counts. Summarize rejected B/C candidates as
   diagnostics; never recommend them as the comparison sample.
3. If fewer than five Tier A profiles are available, say how many are missing
   and why. Never promote B/C, infer missing authority evidence, weaken the ICP,
   or claim success to fill the table. A bounded search can stop at 25 candidates,
   no additional results, or the existing weekly allowance. Explain the actual
   blocker; for allowance exhaustion, read and report its reset time. Ask for
   targeting feedback and keep review pending. Do not blindly rerun a quality
   shortfall or budget exhaustion. A technical research failure may be retried
   once against the saved candidates. A changed ICP requires a fresh sample.
4. When the five-lead sample is ready, explicitly ask: **“Do these leads look
   right, or would you like me to change the targeting? Once you confirm this
   sample, we can connect outreach through Unipile.”** Mirror the founder's
   language. Wait for their answer; reporting results alone is not completion.
5. If the founder requests changes, clarify only the affected business decision,
   apply it through `update`, wait for completion, and repeat the sample and
   review. Approval of an earlier sample never carries across targeting changes.
   Do not use `push` for an existing workspace. If the CLI still reports an old
   completed run after a material targeting change, explain the blocker rather
   than presenting old grades as a fresh comparison.
6. Only explicit confirmation of the current complete sample advances this
   flow to outreach connection. Silence, “targeting updated”, or an earlier ICP
   confirmation is not sample approval. After confirmation, fetch `lifty context
   campaign`, explain that the next step is connecting outreach through Unipile,
   and ask which supported account/channel to connect if not already specified.
   Reuse the founder's stated channel choice; ask only for missing connection
   declarations. Use `connect unipile` for Gmail/Google Workspace email and
   `connect linkedin` for LinkedIn's Unipile browser authorization. Skip an
   already healthy requested connection. Do not ask for approval of the sample
   again once it has been given and targeting has not changed.
7. Connecting an account does not approve sending. Keep the exact campaign
   preview, recipient, sender, copy and schedule approval/activation steps from
   campaign context. No messages or invitations are sent by calibration.

Keep each decision separate: sample feedback first; account connection after
sample confirmation; exact campaign approval before any sending.
