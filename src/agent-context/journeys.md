# Journeys

Select people once with a saved persistent audience, then route them into channel campaigns. Qualified mode reads the canonical Searches/lead eligibility policy. A static audience is an explicit customer choice, not the calibration sample.

Read the journey first. Save audience and graph edits to an immutable draft with expected_version and revision_ref. Publication approves the exact revision/digest; activation separately chooses the approved journey and every exact approved campaign revision for future entrants. Existing runs keep their original binding. A graph save or publication never admits leads or authorizes sends.

The current executable adapter supports email-only or LinkedIn first followed by email. Entries use start, confirmed sent-step receipt plus saved calendar/business-day delay, or unaccepted invitation plus business-day delay. It supports one campaign per channel in a compiled journey, LinkedIn invitation followed by one to three messages, and four or five email steps. These are current adapter limits, not a second sequence-count owner. No arbitrary graph actions, automatic bypass, parallel start, email-to-LinkedIn or delivery expiry is accepted.

Unavailable channels keep their exact approved branch pending. Available channels proceed only where the approved graph permits; a dependency on an unfinished action waits. Graph activation can pin approved-but-paused/unready campaigns without changing their intent. Readiness does not select a new version. Publication is approval evidence, never a published operating state. No resume/adopt action exists.

After an uncertain write, read the same resource before retrying. Foreign workspace/resource selection never falls back. Unknown read is unavailable, not empty/inactive/healthy.
