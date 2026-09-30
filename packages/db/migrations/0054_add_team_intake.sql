ALTER TABLE "teams" ADD COLUMN "intake_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "required_fields" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_intake_notes_length" CHECK (char_length("teams"."intake_notes") <= 20000);--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_required_fields_known" CHECK ("teams"."required_fields" <@ ARRAY['acceptance_criteria', 'code_refs', 'links', 'due_date']::text[] AND cardinality("teams"."required_fields") <= 4);