CREATE TABLE "admin_alert_emails" (
	"org_id" uuid NOT NULL,
	"alert" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_alert_emails_org_id_alert_raised_at_user_id_pk" PRIMARY KEY("org_id","alert","raised_at","user_id"),
	CONSTRAINT "admin_alert_emails_alert_known" CHECK ("admin_alert_emails"."alert" IN ('github_webhook'))
);
--> statement-breakpoint
ALTER TABLE "admin_alert_emails" ADD CONSTRAINT "admin_alert_emails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alert_emails" ADD CONSTRAINT "admin_alert_emails_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;