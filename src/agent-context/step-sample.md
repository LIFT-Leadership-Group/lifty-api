# Section 1 · Find and research five leads

Goal: five researched people under the confirmed target, shown to the founder
as they land. Do `actions` from `next_step` in order.

1. The first-run endpoint enforces platform discovery limits. When it reports
   exhaustion, give its actual reset time and offer outreach setup with saved
   leads meanwhile. Do not introduce a provider key or allowance workflow.
2. `sample_review_post` with body `{}` starts or returns the bounded first run.
   Keep its `run_ref`.
3. Tell the founder you are finding and researching five people who match,
   that it takes a few minutes, and that you will share each one as it lands.
4. `sample_review_progress` with `run_ref`; then pass the returned `cursor`
   and `wait_seconds: 25` until `terminal` is true. Keep one request open at
   a time. Narrate each newly researched person in one line: name, company,
   grade, why. No fixed sleeps; never POST again to check progress.
5. When terminal, call `next_step` for the review.

A failed run is terminal; a read error is not. Retry a failed read with the
same run and cursor. Use `sample_review_get` to read a failure: a technical
research failure may be retried once with `sample_review_post`; allowance
exhaustion reports its reset time. Never buy new leads to chase better grades.
