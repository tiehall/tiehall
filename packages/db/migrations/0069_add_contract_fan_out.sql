CREATE TABLE "contract_fan_out_approvals" (
	"org_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contract_fan_out_approvals_org_id_change_set_id_team_id_pk" PRIMARY KEY("org_id","change_set_id","team_id")
);
--> statement-breakpoint
CREATE TABLE "contract_fan_out_waits" (
	"org_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"waiting_since" timestamp with time zone NOT NULL,
	CONSTRAINT "contract_fan_out_waits_org_id_change_set_id_team_id_pk" PRIMARY KEY("org_id","change_set_id","team_id")
);
--> statement-breakpoint
ALTER TABLE "admin_alert_emails" DROP CONSTRAINT "admin_alert_emails_alert_known";--> statement-breakpoint
ALTER TABLE "contract_change_sets" ADD COLUMN "fan_out_waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contract_fan_out_approvals" ADD CONSTRAINT "contract_fan_out_approvals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_approvals" ADD CONSTRAINT "contract_fan_out_approvals_change_set_fk" FOREIGN KEY ("org_id","change_set_id") REFERENCES "public"."contract_change_sets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_approvals" ADD CONSTRAINT "contract_fan_out_approvals_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_approvals" ADD CONSTRAINT "contract_fan_out_approvals_approved_by_fk" FOREIGN KEY ("org_id","approved_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_waits" ADD CONSTRAINT "contract_fan_out_waits_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_waits" ADD CONSTRAINT "contract_fan_out_waits_change_set_fk" FOREIGN KEY ("org_id","change_set_id") REFERENCES "public"."contract_change_sets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_fan_out_waits" ADD CONSTRAINT "contract_fan_out_waits_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_alert_emails" ADD CONSTRAINT "admin_alert_emails_alert_known" CHECK ("admin_alert_emails"."alert" IN ('github_webhook', 'contract_fan_out'));