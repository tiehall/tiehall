CREATE TABLE "event_sequence" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"last_number" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_sequence" ADD CONSTRAINT "event_sequence_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;