CREATE TABLE "contract_warn_digest_emails" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contract_warn_digest_emails_org_id_team_id_user_id_day_pk" PRIMARY KEY("org_id","team_id","user_id","day")
);
--> statement-breakpoint
CREATE TABLE "contract_warn_digest_entries" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"day" date NOT NULL,
	"report_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contract_warn_digest_entries_org_id_team_id_change_set_id_day_pk" PRIMARY KEY("org_id","team_id","change_set_id","day")
);
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "warn_opens_requests" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_emails" ADD CONSTRAINT "contract_warn_digest_emails_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_emails" ADD CONSTRAINT "contract_warn_digest_emails_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_emails" ADD CONSTRAINT "contract_warn_digest_emails_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_entries" ADD CONSTRAINT "contract_warn_digest_entries_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_entries" ADD CONSTRAINT "contract_warn_digest_entries_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_entries" ADD CONSTRAINT "contract_warn_digest_entries_change_set_fk" FOREIGN KEY ("org_id","change_set_id") REFERENCES "public"."contract_change_sets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_entries" ADD CONSTRAINT "contract_warn_digest_entries_report_fk" FOREIGN KEY ("org_id","report_id") REFERENCES "public"."contract_reports"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_warn_digest_entries_team_day" ON "contract_warn_digest_entries" USING btree ("org_id","team_id","day");