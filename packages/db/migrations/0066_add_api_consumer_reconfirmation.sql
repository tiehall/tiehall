CREATE TABLE "api_consumer_reconfirmation_emails" (
	"org_id" uuid NOT NULL,
	"api_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_consumer_reconfirmation_emails_pk" PRIMARY KEY("org_id","api_id","team_id","requested_at","user_id")
);
--> statement-breakpoint
ALTER TABLE "api_consumers" ADD COLUMN "reconfirmation_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_consumers" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_consumer_reconfirmation_emails" ADD CONSTRAINT "api_consumer_reconfirmation_emails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_consumer_reconfirmation_emails" ADD CONSTRAINT "api_consumer_reconfirmation_emails_declaration_fk" FOREIGN KEY ("org_id","api_id","team_id") REFERENCES "public"."api_consumers"("org_id","api_id","team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_consumer_reconfirmation_emails" ADD CONSTRAINT "api_consumer_reconfirmation_emails_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;