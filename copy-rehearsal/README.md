# Copy rehearsal

This folder is a **local copy rehearsal**. It is for judging Lifty's recommended
outreach drafts. It is not a live Lifty session.

Nothing here logs in, saves a hosted campaign, activates outreach, or sends a
message. The company information is fictional and saved in this folder on
purpose, so we can compare drafts without reading a real workspace.

## What this is for

When a founder asks Lifty to recommend messages during onboarding, Lifty uses
written guidance in the product. We change that guidance, then generate the same
three company scenarios again, and you judge whether the copy got better.

## Files you will use

| File | What it is |
|---|---|
| `scenarios/` | The three frozen company stories. Review these once, then leave them alone so comparisons are fair. |
| `editorial/rules.md` | Outreach rules we agree on. Empty until you supply them. |
| `editorial/examples.md` | Good and bad examples you give me. Empty until you supply them. |
| `scratch/` | Local dumps. Not committed. Includes the current assembled guidance, paste-ready prompts, and saved drafts. |

## How to run another test

Do this after any guidance change, or to capture a baseline before we change
anything.

1. In this repository folder, run:

   ```text
   node --import tsx copy-rehearsal/export-context.mjs
   ```

   That command reads the latest Markdown guidance in a fresh process. It does
   not start the API and does not need passwords.

2. Open this repository in Cursor: `lifty-api`.

3. Start a **new empty chat**. Keep the same Cursor model you used for earlier
   runs. Do not paste old drafts or our editing discussion.

4. Paste the contents of one file from `copy-rehearsal/scratch/prompts/`.
   Start with `01-clear-offer.md` unless we agree to run a different scenario.

5. Judge the copy. Then paste the drafts back into the setup chat, or save them
   yourself as:

   ```text
   copy-rehearsal/scratch/drafts/<revision>--<scenario>.md
   ```

   The export prints the current `revision` values. Use those so we can tell
   which guidance version produced which draft.

## What to look for in the copy

- **Specificity:** does it use the saved offer and audience, without turning
  one sample lead into a fact about every future recipient?
- **Credibility:** does it avoid invented results, customers, websites, or
  research?
- **Voice:** does it sound like this founder, not like generic sales copy?
- **CTA:** is there one clear, answerable ask?
- **Follow-ups:** does each later message add a new reason to reply, instead of
  repeating the first pitch?

## Product behavior to keep

These are already decided for the product. The rehearsal should not change them:

- LinkedIn: invitation with **no note**, then **three messages** after acceptance.
- Email: **five messages**, each with a subject and body.
- Only `{{first_name}}`, `{{last_name}}`, and `{{company_name}}` may be substituted.
- Templates must work for the approved audience, including future eligible leads.
- Channel choice, cadence, stop-on-reply, and campaign approval stay as they are.
