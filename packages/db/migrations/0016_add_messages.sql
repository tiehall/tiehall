CREATE TABLE "message_versions" (
	"org_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_versions_org_id_message_id_version_pk" PRIMARY KEY("org_id","message_id","version"),
	CONSTRAINT "message_versions_version_positive" CHECK ("message_versions"."version" > 0),
	CONSTRAINT "message_versions_body_length" CHECK (char_length("message_versions"."body") BETWEEN 1 AND 65536)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"kind" text NOT NULL,
	"blocking" boolean DEFAULT false NOT NULL,
	"question_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_user_id" uuid,
	"client" text,
	"surface" text,
	"team_id" uuid,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "messages_number_positive" CHECK ("messages"."number" > 0),
	CONSTRAINT "messages_kind_known" CHECK ("messages"."kind" IN ('comment', 'question', 'answer')),
	CONSTRAINT "messages_blocking_questions_only" CHECK (NOT "messages"."blocking" OR "messages"."kind" = 'question'),
	CONSTRAINT "messages_answers_name_questions" CHECK (("messages"."kind" = 'answer') = ("messages"."question_id" IS NOT NULL)),
	CONSTRAINT "messages_actor_kind_known" CHECK ("messages"."actor_kind" IN ('agent', 'web_session', 'system', 'integration')),
	CONSTRAINT "messages_surface_known" CHECK ("messages"."surface" IS NULL OR "messages"."surface" IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')),
	CONSTRAINT "messages_actor_names_user" CHECK ("messages"."actor_kind" NOT IN ('agent', 'web_session') OR ("messages"."actor_user_id" IS NOT NULL AND "messages"."surface" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_message_fk" FOREIGN KEY ("org_id","message_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_question_fk" FOREIGN KEY ("org_id","question_id") REFERENCES "public"."messages"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_actor_user_fk" FOREIGN KEY ("org_id","actor_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_request_number" ON "messages" USING btree ("org_id","request_id","number");--> statement-breakpoint
CREATE INDEX "messages_question_id" ON "messages" USING btree ("org_id","question_id");