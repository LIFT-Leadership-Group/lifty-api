# Researched leads

Purpose: list the people Lifty has researched for this workspace. Read
`references.common` first.

`list` returns researched people newest first, at most `limit` (1 to 100,
default 25) per page. Each item has the person, title, company, LinkedIn
profile URL, grade (A, B or C), fit rationale, `researched_at` (when their
first research completed) and `research_url`, the dashboard page with the full
research. Only people whose research completed appear.

- Filter with `grade` (one or more of A, B, C) and `week` (the Monday,
  `YYYY-MM-DD`, of the UTC week whose volume the person counted in). The
  people listed for a week are the ones counted in that week's `completed`
  on `research-schedule status`.
- Page with the returned `next_cursor`; pass it back unchanged as `cursor`.
  `null` means the last page. Keep the same filters while paging.
- A bad cursor, grade or week returns `INVALID_REQUEST` with repair issues.
  `LEADS_UNAVAILABLE` means unknown: retry the same request.

Grades describe fit with the confirmed targeting; every researched person
counted toward weekly volume regardless of grade. Present the founder's
leads with your read first, then person, company, grade, LinkedIn URL and
rationale. Lead detail and feedback (thumbs up or down) live in the
dashboard; send the founder to `research_url` for them. Leads cannot be
created, edited or deleted here.
