CREATE TABLE "contract_reports" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"api_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository_owner_id" bigint NOT NULL,
	"job_workflow_ref" text NOT NULL,
	"pull_request_number" integer NOT NULL,
	"base_ref" text NOT NULL,
	"base_sha" text NOT NULL,
	"head_ref" text NOT NULL,
	"head_sha" text NOT NULL,
	"engine_name" text NOT NULL,
	"engine_version" text NOT NULL,
	"changes" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_reports_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "contract_reports_pull_request_number_positive" CHECK ("contract_reports"."pull_request_number" > 0),
	CONSTRAINT "contract_reports_shas" CHECK ("contract_reports"."base_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$' AND "contract_reports"."head_sha" ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
	CONSTRAINT "contract_reports_changes_is_list" CHECK (jsonb_typeof("contract_reports"."changes") = 'array')
);
--> statement-breakpoint
ALTER TABLE "contract_reports" ADD CONSTRAINT "contract_reports_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_reports" ADD CONSTRAINT "contract_reports_api_fk" FOREIGN KEY ("org_id","api_id") REFERENCES "public"."apis"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contract_reports_change_set" ON "contract_reports" USING btree ("org_id","api_id","pull_request_number","received_at");