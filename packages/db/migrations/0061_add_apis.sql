CREATE TABLE "apis" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider_team_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository_owner_id" bigint NOT NULL,
	"repository_full_name" text NOT NULL,
	"job_workflow_ref" text,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"registered_by" uuid NOT NULL,
	CONSTRAINT "apis_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "apis_name_format" CHECK ("apis"."name" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
	CONSTRAINT "apis_repository_ids_positive" CHECK ("apis"."repository_id" > 0 AND "apis"."repository_owner_id" > 0),
	CONSTRAINT "apis_repository_full_name_length" CHECK (char_length("apis"."repository_full_name") BETWEEN 3 AND 200),
	CONSTRAINT "apis_job_workflow_ref_length" CHECK (char_length("apis"."job_workflow_ref") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_provider_team_fk" FOREIGN KEY ("org_id","provider_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_registered_by_fk" FOREIGN KEY ("org_id","registered_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "apis_name" ON "apis" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "apis_repository" ON "apis" USING btree ("org_id","repository_id");