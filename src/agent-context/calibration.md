# Review targeting while progressing outreach setup

Apply this workflow after the initial lead run and after every targeting or
research-criteria change. The review sample is five researched **Tier A or B**
leads under the current confirmed ICP, each with its actual LinkedIn profile
URL and a concrete fit rationale. Preserve each grade. C leads never count.
A sample containing five B leads is valid, but still needs explicit founder
acceptance.

The sample measures targeting quality; it is not a prerequisite for outreach
setup. If the founder wants to continue, help choose a channel, connect their
account and draft outreach while calibration remains pending. This also
applies after an ICP change, with fewer than five leads, no A leads, exhausted
discovery allowance or no CRM. Pause only the operation that needs a missing
input. Exact campaign approval and authorization to send remain separate.

The A/B rule applies when the returned `calibration_policy` is
`qualified_ab_v1`. Historical `tier_a_v1`, missing, or unknown policies retain
their A-only eligibility. Do not reinterpret an old successful run as a new
A/B sample or relabel its research. Follow the current stage result and explain
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

Aim to surface strong Tier A candidates on the first research run. If that
misses, identify the cause from saved evidence and recommend one specific
targeting or research-instruction correction for a second run, subject to the
founder's intent and available allowance. This is a quality objective, not a
promise of A grades or permission to relax confirmed limits. Never relabel
leads, invent fit, or acquire repeated waves to satisfy the objective.

## Review the first cohort

1. Wait for configuration import or the targeting update to finish. Before
   new discovery, fetch `context capacity` and read `stage capacity get`.
   Fetch `context sample-review`, then use `stage sample-review post --input -`
   with `{ "body": {} }` to research the initial five candidates. Explicitly
   read `stage sample-review get` until its result is confirmed; the generic
   transport does not poll. The service stops
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
   `stage sample-review get` retrieves that saved cohort; it does not authorize another
   acquisition wave. Agree on the business adjustment before applying it.
   For allowance exhaustion, report the returned reset time. A technical
   research failure may be retried once against the saved candidates,
   preserving completed research and acquisition usage. Never blindly retry
   quality shortfalls or budget exhaustion. A reset date limits new discovery,
   not account connection, reviewing saved evidence or drafting outreach.
5. When five eligible profiles are ready, ask: **"Do these leads look right,
   or would you like me to change the targeting? We can also prepare outreach
   while refining the sample."** Mirror the founder's language.
   For a B-only sample, explicitly say all five are B, explain from their
   evidence why none are A, and ask whether to accept that sample or refine
   targeting. Reporting results is not sample approval. If the answer requests
   outreach setup, continue that work instead of repeating the sample question.
6. If the founder requests changes, clarify only the affected business
   decision, fetch `context targeting` or `context research-criteria`, follow its
   generated-artifact PATCH and exact receipt/readback workflow, then repeat the
   sample and review. Approval of an earlier sample never carries across
   targeting or research-criteria changes. Preserve existing connections and
   drafts; only the sample's acceptance is stale. Do not repeat the initial onboarding POST for an existing
   configured workspace. If the stage still reports an old completed run after a material
   change, explain the blocker instead of presenting old grades as fresh.
7. When the founder asks to continue outreach setup, fetch `context campaigns` and collect only missing account/channel declarations. Reuse the
   stated channel choice. Read the current `sending-accounts` stage for
   Gmail/Google Workspace email or LinkedIn authorization and exact-attempt
   verification. Skip an already healthy connection unless reconnecting was
   explicitly requested. If they choose existing B leads,
   review their saved evidence against the current ICP and make the selected
   recipients explicit. Keep recorded grades and calibration status truthful;
   a changed ICP does not make all saved evidence unusable. Missing evidence
   may require a recipient-specific check, not five new leads before setup.
8. Connecting an account does not approve sending. Keep the exact campaign
   preview, recipient, sender, copy and schedule approval/activation steps
   from the campaigns stage and its channel reference. Calibration sends no messages or invitations.

For example, after an ICP change with discovery allowance exhausted and the
founder saying "continue with Tier B leads", respond along these lines:
"We can prepare outreach with the B leads you choose. I'll check their saved
research against the updated targeting, and we can connect your account and
draft the messages now. New discovery can wait for the allowance reset."
Then perform the available next step or ask for its one missing decision.
Do not close with a multi-day wait when useful setup work can proceed now.
