CREATE TABLE "backups" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"file" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	CONSTRAINT "backups_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "backups_size_not_negative" CHECK ("backups"."size_bytes" >= 0),
	CONSTRAINT "backups_file_length" CHECK (char_length("backups"."file") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backups_finished_at" ON "backups" USING btree ("org_id","finished_at");