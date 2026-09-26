CREATE TABLE "read_cursors" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reader" text NOT NULL,
	"acknowledged" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "read_cursors_org_id_user_id_reader_pk" PRIMARY KEY("org_id","user_id","reader"),
	CONSTRAINT "read_cursors_acknowledged_not_negative" CHECK ("read_cursors"."acknowledged" >= 0),
	CONSTRAINT "read_cursors_reader_length" CHECK (char_length("read_cursors"."reader") BETWEEN 1 AND 2048)
);
--> statement-breakpoint
ALTER TABLE "read_cursors" ADD CONSTRAINT "read_cursors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_cursors" ADD CONSTRAINT "read_cursors_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;