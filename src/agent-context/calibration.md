# Review targeting before connecting outreach

Apply this workflow after the initial lead run and after every targeting or
research-criteria change. The review sample is five researched **Tier A or B**
leads under the current confirmed ICP, each with its actual LinkedIn profile
URL and a concrete fit rationale. Preserve each grade. C leads never count.
A sample containing five B leads is valid, but still needs explicit founder
acceptance.

The A/B rule applies when the returned `calibration_policy` is
`qualified_ab_v1`. Historical `tier_a_v1`, missing, or unknown policies retain
their A-only eligibility. Do not reinterpret an old successful run as a new
A/B sample or relabel its research. Follow the current CLI result and explain
any compatibility blocker.

## Read the evidence before changing the search

A means strong positive company and buyer fit, supported by evidence or
credible proxies, without a confirmed hard exclusion. B means meaningful
positive fit whose company fit or buyer relevance is less convincing. C means
a confirmed hard exclusion or clear mismatch with the confirmed target.

For each criterion, distinguish required conditions, preferences, and hard
exclusions. Evidence can support a criterion, contradict it, or leave it
unknown. Missing ARR or sales-leadership evidence is not itself a failed gate,
an automatic downgrade, or proof of A. Require positive fit for A and B.
Keep estimates and unknowns visible. Research retrieval failures are technical
failures, not evidence against a company. Do not silently change grades to
fill the sample.

## Review the first cohort

1. Wait for configuration import or the targeting update to finish. Before
   new discovery, read `lifty get allowance --workspace <workspace-id>`.
   Run `lifty run` to research the initial five candidates. The service stops
   for review if that cohort cannot fill the qualified sample. It does not
   acquire repeated waves to chase five A grades.
2. Present the returned cohort as a table with person, company, actual grade,
   **LinkedIn profile URL**, fit rationale, and evidence gaps. Mark C leads and
   profiles missing a valid LinkedIn URL or rationale as excluded from the
   review sample. Use only returned profile URLs. Optional research/dashboard
   links never replace them. Preserve discovery and research counts and show
   how many of the required five sample places are filled.
3. When fewer than five eligible profiles remain, explain the specific
   shortfall and propose the smallest useful adjustment. Wrong industries,
   geography, or company sizes suggest a discovery problem. Positive-fit
   companies downgraded only for unavailable evidence suggest a rubric
   problem. Confirmed exclusions stay excluded. Retrieval failures call for
   technical recovery. Do not remove an exclusion, widen the founder's market,
   invent missing facts, or claim success to fill the table.
4. A `calibration_review_required` result is a review checkpoint. Repeating
   `lifty run` retrieves that saved cohort; it does not authorize another
   acquisition wave. Agree on the business adjustment before applying it.
   For allowance exhaustion, report the returned reset time. A technical
   research failure may be retried once against the saved candidates,
   preserving completed research and acquisition usage. Never blindly retry
   quality shortfalls or budget exhaustion.
5. When five eligible profiles are ready, ask: **"Do these leads look right,
   or would you like me to change the targeting? Once you confirm this sample,
   we can connect outreach through Unipile."** Mirror the founder's language.
   For a B-only sample, explicitly say all five are B, explain from their
   evidence why none are A, and ask whether to accept that sample or refine
   targeting. Wait for the answer; reporting results is not sample approval.
6. If the founder requests changes, clarify only the affected business
   decision, apply it through `update`, wait for completion, and repeat the
   sample and review. Approval of an earlier sample never carries across
   targeting or research-criteria changes. Do not use `push` for an existing
   workspace. If the CLI still reports an old completed run after a material
   change, explain the blocker instead of presenting old grades as fresh.
7. Only explicit confirmation of the current complete sample advances this
   flow to outreach connection. Silence, "targeting updated", or an earlier
   ICP confirmation is not sample approval. Fetch `lifty context campaign`,
   explain that the next step is connecting outreach through Unipile, and
   collect only missing account/channel declarations. Reuse the founder's
   stated channel choice. Use `connect unipile` for Gmail/Google Workspace
   email and `connect linkedin` for LinkedIn browser authorization. Skip an
   already healthy requested connection. Do not ask for sample approval again
   while targeting remains unchanged.
8. Connecting an account does not approve sending. Keep the exact campaign
   preview, recipient, sender, copy and schedule approval/activation steps
   from campaign context. Calibration sends no messages or invitations.
