CREATE TABLE "packet_revisions" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"packet" json NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"client" text,
	"surface" text,
	"team_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "packet_revisions_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "packet_revisions_number_positive" CHECK ("packet_revisions"."number" > 0),
	CONSTRAINT "packet_revisions_packet_is_object" CHECK (json_typeof("packet_revisions"."packet") = 'object'),
	CONSTRAINT "packet_revisions_actor_kind_known" CHECK ("packet_revisions"."actor_kind" IN ('agent', 'web_session', 'system', 'integration')),
	CONSTRAINT "packet_revisions_surface_known" CHECK ("packet_revisions"."surface" IS NULL OR "packet_revisions"."surface" IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')),
	CONSTRAINT "packet_revisions_actor_names_user" CHECK ("packet_revisions"."actor_kind" NOT IN ('agent', 'web_session') OR ("packet_revisions"."actor_user_id" IS NOT NULL AND "packet_revisions"."surface" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "packet_revisions" ADD CONSTRAINT "packet_revisions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_revisions" ADD CONSTRAINT "packet_revisions_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_revisions" ADD CONSTRAINT "packet_revisions_actor_user_fk" FOREIGN KEY ("org_id","actor_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "packet_revisions" ADD CONSTRAINT "packet_revisions_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "packet_revisions_request_number" ON "packet_revisions" USING btree ("org_id","request_id","number");