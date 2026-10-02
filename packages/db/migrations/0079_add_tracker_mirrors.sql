CREATE TABLE "mirrors" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"tracker" text NOT NULL,
	"target" text NOT NULL,
	"issue" text,
	"marker" uuid DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issue_created_at" timestamp with time zone,
	"pushed" jsonb,
	"tracker_state" jsonb,
	"expected_state" jsonb,
	CONSTRAINT "mirrors_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "mirrors_tracker_known" CHECK ("mirrors"."tracker" IN ('github', 'jira')),
	CONSTRAINT "mirrors_target_length" CHECK (char_length("mirrors"."target") BETWEEN 1 AND 200),
	CONSTRAINT "mirrors_issue_length" CHECK ("mirrors"."issue" IS NULL OR char_length("mirrors"."issue") BETWEEN 1 AND 200),
	CONSTRAINT "mirrors_pushed_is_object" CHECK ("mirrors"."pushed" IS NULL OR jsonb_typeof("mirrors"."pushed") = 'object'),
	CONSTRAINT "mirrors_tracker_state_is_object" CHECK ("mirrors"."tracker_state" IS NULL OR jsonb_typeof("mirrors"."tracker_state") = 'object'),
	CONSTRAINT "mirrors_expected_state_is_object" CHECK ("mirrors"."expected_state" IS NULL OR jsonb_typeof("mirrors"."expected_state") = 'object')
);
--> statement-breakpoint
CREATE TABLE "tracker_mappings" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"tracker" text NOT NULL,
	"target" text NOT NULL,
	"target_name" text NOT NULL,
	"mirror_on_open" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_mappings_org_id_team_id_pk" PRIMARY KEY("org_id","team_id"),
	CONSTRAINT "tracker_mappings_tracker_known" CHECK ("tracker_mappings"."tracker" IN ('github', 'jira')),
	CONSTRAINT "tracker_mappings_target_length" CHECK (char_length("tracker_mappings"."target") BETWEEN 1 AND 200),
	CONSTRAINT "tracker_mappings_target_name_length" CHECK (char_length("tracker_mappings"."target_name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mirrors" ADD CONSTRAINT "mirrors_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_mappings" ADD CONSTRAINT "tracker_mappings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_mappings" ADD CONSTRAINT "tracker_mappings_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mirrors_request_place" ON "mirrors" USING btree ("org_id","request_id","team_id","tracker","target");--> statement-breakpoint
CREATE UNIQUE INDEX "mirrors_issue" ON "mirrors" USING btree ("org_id","tracker","target","issue") WHERE "mirrors"."issue" IS NOT NULL;