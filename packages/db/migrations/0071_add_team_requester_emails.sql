CREATE TABLE "team_requester_emails" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"opted_in_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_requester_emails_org_id_user_id_team_id_pk" PRIMARY KEY("org_id","user_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "team_requester_emails" ADD CONSTRAINT "team_requester_emails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_requester_emails" ADD CONSTRAINT "team_requester_emails_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_requester_emails" ADD CONSTRAINT "team_requester_emails_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_requester_emails_team" ON "team_requester_emails" USING btree ("org_id","team_id");