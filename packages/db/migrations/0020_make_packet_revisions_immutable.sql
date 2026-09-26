-- Packet revisions are immutable (handoff-packet: Immutable, numbered revisions; design.md, Design rules: Handoff
-- packet): these triggers refuse every update, delete and truncation of a revision, whoever tries, so a change to a
-- packet can only add the next revision and every earlier one reads back as it was. The app role holds only insert and
-- select on the table, and owns neither it nor this function, so it can neither drop nor disable the triggers.
CREATE FUNCTION "tiehall_refuse_packet_revision_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Packet revisions are immutable: % of %.% is refused.', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tiehall_refuse_packet_revision_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "packet_revisions_refuse_update_delete" BEFORE UPDATE OR DELETE ON "packet_revisions"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_packet_revision_change"();
--> statement-breakpoint
CREATE TRIGGER "packet_revisions_refuse_truncate" BEFORE TRUNCATE ON "packet_revisions"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_packet_revision_change"();
