CREATE TABLE "events" (
	"org_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"class" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"client" text,
	"surface" text,
	"team_id" uuid,
	"operator_command" text,
	CONSTRAINT "events_org_id_number_pk" PRIMARY KEY("org_id","number"),
	CONSTRAINT "events_number_positive" CHECK ("events"."number" > 0),
	CONSTRAINT "events_class_known" CHECK ("events"."class" IN ('domain', 'security')),
	CONSTRAINT "events_data_is_object" CHECK (jsonb_typeof("events"."data") = 'object'),
	CONSTRAINT "events_actor_kind_known" CHECK ("events"."actor_kind" IN ('agent', 'web_session', 'system', 'integration', 'operator')),
	CONSTRAINT "events_surface_known" CHECK ("events"."surface" IS NULL OR "events"."surface" IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')),
	CONSTRAINT "events_actor_names_user" CHECK ("events"."actor_kind" NOT IN ('agent', 'web_session') OR ("events"."actor_user_id" IS NOT NULL AND "events"."surface" IS NOT NULL)),
	CONSTRAINT "events_operator_names_command" CHECK (("events"."actor_kind" = 'operator') = ("events"."operator_command" IS NOT NULL) AND ("events"."actor_kind" <> 'operator' OR ("events"."actor_user_id" IS NULL AND "events"."client" IS NULL AND "events"."surface" IS NULL AND "events"."team_id" IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;