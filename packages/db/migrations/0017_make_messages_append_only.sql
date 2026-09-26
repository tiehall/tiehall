-- Messages are append-only (requests: Messages are append-only; design.md, Design rules: Requests and events):
-- these triggers refuse every update, delete and truncation of a message and of a message's versions, whoever
-- tries, so an edit can only add a version and every earlier version reads back as it was written. The app role
-- holds only insert and select on these tables, and owns neither them nor this function, so it can neither drop
-- nor disable the triggers.
CREATE FUNCTION "tiehall_refuse_message_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Messages are append-only: % of %.% is refused.', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tiehall_refuse_message_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "messages_refuse_update_delete" BEFORE UPDATE OR DELETE ON "messages"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_message_change"();
--> statement-breakpoint
CREATE TRIGGER "messages_refuse_truncate" BEFORE TRUNCATE ON "messages"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_message_change"();
--> statement-breakpoint
CREATE TRIGGER "message_versions_refuse_update_delete" BEFORE UPDATE OR DELETE ON "message_versions"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_message_change"();
--> statement-breakpoint
CREATE TRIGGER "message_versions_refuse_truncate" BEFORE TRUNCATE ON "message_versions"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_message_change"();
