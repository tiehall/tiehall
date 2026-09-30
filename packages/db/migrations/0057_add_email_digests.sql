CREATE TABLE "email_digests" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"updates" integer NOT NULL,
	CONSTRAINT "email_digests_org_id_user_id_day_pk" PRIMARY KEY("org_id","user_id","day"),
	CONSTRAINT "email_digests_updates_positive" CHECK ("email_digests"."updates" > 0)
);
--> statement-breakpoint
ALTER TABLE "email_digests" ADD CONSTRAINT "email_digests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_digests" ADD CONSTRAINT "email_digests_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;