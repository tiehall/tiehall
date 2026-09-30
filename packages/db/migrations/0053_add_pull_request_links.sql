CREATE TABLE "pull_request_links" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"repository_owner" text NOT NULL,
	"repository_name" text NOT NULL,
	"number" integer NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"client" text,
	"surface" text,
	"team_id" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pull_request_links_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "pull_request_links_number_positive" CHECK ("pull_request_links"."number" > 0),
	CONSTRAINT "pull_request_links_owner_lower_case" CHECK ("pull_request_links"."repository_owner" = lower("pull_request_links"."repository_owner")),
	CONSTRAINT "pull_request_links_name_lower_case" CHECK ("pull_request_links"."repository_name" = lower("pull_request_links"."repository_name")),
	CONSTRAINT "pull_request_links_actor_kind_known" CHECK ("pull_request_links"."actor_kind" IN ('agent', 'web_session', 'system', 'integration')),
	CONSTRAINT "pull_request_links_surface_known" CHECK ("pull_request_links"."surface" IS NULL OR "pull_request_links"."surface" IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')),
	CONSTRAINT "pull_request_links_actor_names_user" CHECK ("pull_request_links"."actor_kind" NOT IN ('agent', 'web_session') OR ("pull_request_links"."actor_user_id" IS NOT NULL AND "pull_request_links"."surface" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "pull_request_links" ADD CONSTRAINT "pull_request_links_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_links" ADD CONSTRAINT "pull_request_links_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_links" ADD CONSTRAINT "pull_request_links_actor_user_fk" FOREIGN KEY ("org_id","actor_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_request_links" ADD CONSTRAINT "pull_request_links_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_links_request_pull_request" ON "pull_request_links" USING btree ("org_id","request_id","repository_owner","repository_name","number");--> statement-breakpoint
CREATE INDEX "pull_request_links_pull_request" ON "pull_request_links" USING btree ("org_id","repository_owner","repository_name","number");