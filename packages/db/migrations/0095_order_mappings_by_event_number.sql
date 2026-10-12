-- A mapping keeps the number of the org's last event when it was made, read while it holds the event counter, so the
-- mirror job orders a request's claims and openings against it as they committed (decisions-from-groups-15-28,
-- design.md, Technical decisions: T17). A mapping made before keeps none, and its time is compared instead. The step
-- only adds a column that may be null, so the previous image still runs.
ALTER TABLE "tracker_mappings" ADD COLUMN "made_after_event" bigint;
