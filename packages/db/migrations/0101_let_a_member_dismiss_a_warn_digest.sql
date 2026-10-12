CREATE TABLE "contract_warn_digest_dismissals" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"day" date NOT NULL,
	"dismissed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "contract_warn_digest_dismissals_org_id_user_id_team_id_day_pk" PRIMARY KEY("org_id","user_id","team_id","day")
);
--> statement-breakpoint
ALTER TABLE "contract_warn_digest_dismissals" ADD CONSTRAINT "contract_warn_digest_dismissals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_dismissals" ADD CONSTRAINT "contract_warn_digest_dismissals_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_warn_digest_dismissals" ADD CONSTRAINT "contract_warn_digest_dismissals_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;