CREATE TABLE "request_counters" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"last_number" integer NOT NULL,
	CONSTRAINT "request_counters_org_id_team_id_pk" PRIMARY KEY("org_id","team_id"),
	CONSTRAINT "request_counters_last_number_positive" CHECK ("request_counters"."last_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"target_team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"claimant_user_id" uuid,
	"resume_state" text,
	"requesting_user_id" uuid,
	"requesting_team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "requests_number_positive" CHECK ("requests"."number" > 0),
	CONSTRAINT "requests_title_length" CHECK (char_length("requests"."title") BETWEEN 1 AND 200),
	CONSTRAINT "requests_state_known" CHECK ("requests"."state" IN ('open', 'claimed', 'in_progress', 'needs_info', 'done', 'declined', 'withdrawn')),
	CONSTRAINT "requests_resume_state_known" CHECK ("requests"."resume_state" IS NULL OR "requests"."resume_state" IN ('open', 'claimed', 'in_progress')),
	CONSTRAINT "requests_needs_info_resumes" CHECK ("requests"."state" <> 'needs_info' OR "requests"."resume_state" IS NOT NULL),
	CONSTRAINT "requests_resume_state_only_when_waiting" CHECK ("requests"."resume_state" IS NULL OR "requests"."state" IN ('needs_info', 'done', 'declined', 'withdrawn')),
	CONSTRAINT "requests_open_unclaimed" CHECK ("requests"."state" <> 'open' OR "requests"."claimant_user_id" IS NULL),
	CONSTRAINT "requests_claimed_has_claimant" CHECK ("requests"."state" NOT IN ('claimed', 'in_progress') OR "requests"."claimant_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "request_counters" ADD CONSTRAINT "request_counters_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_counters" ADD CONSTRAINT "request_counters_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_target_team_fk" FOREIGN KEY ("org_id","target_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requesting_team_fk" FOREIGN KEY ("org_id","requesting_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_requesting_user_fk" FOREIGN KEY ("org_id","requesting_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_claimant_fk" FOREIGN KEY ("org_id","claimant_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requests_team_number" ON "requests" USING btree ("org_id","target_team_id","number");--> statement-breakpoint
CREATE INDEX "requests_created_at" ON "requests" USING btree ("org_id","created_at");