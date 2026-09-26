-- What a proposal proposes never changes (requests: What a proposal records and shows; design.md, Decisions this
-- change rests on: D30 (4)): these triggers refuse every update of a proposal that changes anything but where it is
-- (its state, when it ended and why it was cancelled), and every delete and truncation of a proposal, so a different
-- commitment can only be a new proposal. The confirmations a proposal has received never change either: their table
-- refuses every update, delete and truncation, so a confirmation, once given, stays valid while the proposal waits.
-- The app role owns neither the tables nor these functions, so it can neither drop nor disable the triggers.
CREATE FUNCTION "tiehall_refuse_proposal_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (to_jsonb(NEW) - ARRAY['state', 'ended_at', 'cancel_reason']) = (to_jsonb(OLD) - ARRAY['state', 'ended_at', 'cancel_reason']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Proposals are immutable: % of what %.% proposes is refused.', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tiehall_refuse_proposal_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "proposals_refuse_change" BEFORE UPDATE OR DELETE ON "proposals"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_proposal_change"();
--> statement-breakpoint
CREATE TRIGGER "proposals_refuse_truncate" BEFORE TRUNCATE ON "proposals"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_proposal_change"();
--> statement-breakpoint
CREATE FUNCTION "tiehall_refuse_proposal_confirmation_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Proposal confirmations are immutable: % of %.% is refused.', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "tiehall_refuse_proposal_confirmation_change"() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "proposal_confirmations_refuse_update_delete" BEFORE UPDATE OR DELETE ON "proposal_confirmations"
FOR EACH ROW EXECUTE FUNCTION "tiehall_refuse_proposal_confirmation_change"();
--> statement-breakpoint
CREATE TRIGGER "proposal_confirmations_refuse_truncate" BEFORE TRUNCATE ON "proposal_confirmations"
FOR EACH STATEMENT EXECUTE FUNCTION "tiehall_refuse_proposal_confirmation_change"();
