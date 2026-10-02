# Journeys

A Journey selects people once with one persistent audience rule and holds the shared stops (reply, meeting booked, suppression, manual stop) for every channel. Its participating Campaigns decide when each channel starts. Qualified mode reads the canonical Searches lead eligibility; a static audience is an explicit customer choice, never the calibration sample. Eligible current and future leads start the Journey once.

Read the Journey first. Save audience edits to an immutable draft with expected_version and revision_ref. Publish approves one exact revision/digest. Activate uses that approved revision for new Journey starts only. Saving or publishing never starts Journeys, pauses work or authorizes sends.

The executable version is derived automatically: the active Journey revision plus the revision each activated Campaign selected, and the graph compiled from them. You never send a graph, binding or pin list. A started Journey keeps the executable version it started with, including the Email revision of a lead that has not reached email yet. `executable_version.graph.status` is `compiling` until the graph is installed; no Journey starts on it before then. `executable_version` is null until the Journey revision and a starting Campaign are both active.

The current executable adapter starts each Journey in one Campaign (LinkedIn or email) and supports email starting after LinkedIn. It runs one Campaign per channel, a LinkedIn invitation followed by one to three messages, and four or five emails. These are adapter limits, not a second sequence-count owner.

Unavailable channel data keeps that Campaign pending; another Campaign proceeds only where its start rules permit, and a dependency on an unfinished step waits. A Journey has no pause: pause the Campaign whose automatic steps must stop.

After an uncertain write, read the same resource before retrying. Foreign workspace/resource selection never falls back. An unknown read is unavailable, not empty, inactive or healthy.
