CREATE TABLE "contract_change_requests" (
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"change_set_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_change_requests_org_id_request_id_pk" PRIMARY KEY("org_id","request_id")
);
--> statement-breakpoint
CREATE TABLE "contract_change_sets" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"pull_request_number" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_report_id" uuid,
	CONSTRAINT "contract_change_sets_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "contract_change_sets_pull_request_number_positive" CHECK ("contract_change_sets"."pull_request_number" > 0)
);
--> statement-breakpoint
ALTER TABLE "contract_change_requests" ADD CONSTRAINT "contract_change_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_requests" ADD CONSTRAINT "contract_change_requests_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_requests" ADD CONSTRAINT "contract_change_requests_change_set_fk" FOREIGN KEY ("org_id","change_set_id") REFERENCES "public"."contract_change_sets"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_requests" ADD CONSTRAINT "contract_change_requests_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_sets" ADD CONSTRAINT "contract_change_sets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_sets" ADD CONSTRAINT "contract_change_sets_api_fk" FOREIGN KEY ("org_id","api_id") REFERENCES "public"."apis"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_change_sets" ADD CONSTRAINT "contract_change_sets_applied_report_fk" FOREIGN KEY ("org_id","applied_report_id") REFERENCES "public"."contract_reports"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_change_requests_change_set_team" ON "contract_change_requests" USING btree ("org_id","change_set_id","team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_change_sets_pull_request" ON "contract_change_sets" USING btree ("org_id","api_id","repository_id","pull_request_number");