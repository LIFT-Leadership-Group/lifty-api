# Founder interview contract

The pre-auth interview has one job: collect enough confirmed targeting context
to provision a safe workspace. Sample calibration and outreach setup happen
later.

## Sequencing

Ask for one coherent decision block at a time, and only when a bootstrap gate
is missing. A block may request up to three tightly related answers when they
describe one judgment. Good blocks include company description plus primary
motion, industry plus numeric size floor and unit, or persona role, titles, and
organizational tell. Wait for the answer before moving to the next block. Never
group unrelated gates.

Reuse answers already given. Do not turn each field or researched detail into a
separate confirmation.

If the founder says `skip`, `no sé`, `avancemos`, or an equivalent:

- skip the question immediately when it belongs to sample calibration or
  outreach;
- for a missing bootstrap gate, offer one concise hypothesis from public
  research and ask only for confirmation or correction;
- never claim that deferred questions are mandatory for the writer.

Do not repeat a confirmation before asking the next necessary question. When
the founder changes an answer, state the replacement once and store the newest
value in `founder_statement_history`.

## Public research playback

Research the company website, relevant public profiles, case studies, hiring
pages, and reputable news before asking questions. Open with a short,
confident read — what the company does, who it likely sells to, the likely
personas, and the main unknowns — written as your take on their business, not
a form to validate. Ask the founder to confirm or correct it in one go.

Every researched value stays `inferred` — an internal label, never shown to
the founder — until the founder confirms or corrects it. Confirmed research can fill a bootstrap field. Optional research, including
named example companies, remains outside the configuration when unconfirmed.

Never infer the numeric size boundary, hard exclusion, persona role, or
organizational tell without founder confirmation.

## Bootstrap interview

### Company and motion

Capture a plain company description and one primary motion. Record secondary
motions as `parked` without interviewing them.

### Initial ICP

Capture industries in, a numeric size floor and unit, and at least one hard
exclusion. A ceiling and industries out may stay unknown. If the founder
bundles two operating states, ask which is primary only when the distinction
changes the initial search.

### Initial personas

Capture at least one persona with:

- its role in this motion, `decision_maker` or `influencer`;
- at least one first-contact title;
- the organizational tell that supports the role.

Recommend the role from authority, not title. Budget or final approval points
to `decision_maker`. Access, advocacy, or control of communication without
final approval points to `influencer`. A founder is a `decision_maker` when no
dedicated owner exists and the founder approves the purchase.

Do not ask which similar titles waste time, who usually replies, or for more
titles once the initial persona gate passes. The sample will answer those
questions with evidence.

## Five bootstrap gates

Write the draft as soon as these five items exist:

1. A standalone company description.
2. One primary motion.
3. A numeric size floor plus its unit.
4. At least one hard exclusion.
5. At least one persona with role, title, and organizational tell.

Industries in are also required for the initial search. Empty example-company
and industries-out arrays are valid. Do not keep interviewing to fill optional
fields.

## Deferred stages

The workspace draft records a pending calibration on five researched Tier A
leads (`lead_target: 5`), each with a LinkedIn profile URL. Follow
`references.calibration` for the feedback and confirmation gate. Sample review owns:

- negative or low-value titles;
- observed reply patterns;
- public timing and urgency signals;
- tooling judgment;
- boundary cases and targeting refinements.

Outreach remains `deferred_until_sample_accepted`. Do not ask about tone,
forbidden copy moves, sender voice, CTA, channels, or sequence preferences in
the pre-auth interview. A research or CRM-only workspace never needs those
answers.

## Close

Play back the five bootstrap decisions in plain founder language — who you'll
target and why — not field names. Frame what remains deferred as what happens
next, not as a list of skipped questions. If the founder has already confirmed
the values or asked to advance, write the draft without another approval loop.
