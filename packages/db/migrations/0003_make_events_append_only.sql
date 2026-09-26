-- The activity log is append-only (activity-log: The activity log is append-only; design.md, Self-hosting
-- decisions: S14): these triggers refuse every update, delete and truncation of an event, whoever tries. The
-- app role holds only insert and select on the event tables, and owns neither them nor this function, so it
-- can neither drop nor disable the triggers. A later event table gets the same two triggers.
CREATE FUNCTION "tiehall_refuse_event_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Events are append-only: % of %.% is refused.', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tiehall_refuse_event_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "events_refuse_update_delete" BEFORE UPDATE OR DELETE ON "events"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_event_change"();
--> statement-breakpoint
CREATE TRIGGER "events_refuse_truncate" BEFORE TRUNCATE ON "events"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_event_change"();
