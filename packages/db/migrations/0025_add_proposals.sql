CREATE TABLE "proposals" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"second_confirmation" text[] DEFAULT '{}' NOT NULL,
	"accountable_user_id" uuid NOT NULL,
	"accountable_side" text NOT NULL,
	"actor_kind" text NOT NULL,
	"client" text,
	"surface" text,
	"team_id" uuid,
	"change" json NOT NULL,
	"base_revision" integer,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "proposals_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "proposals_kind_known" CHECK ("proposals"."kind" IN ('due_date', 'scope', 'decline', 'reassign', 'withdraw', 'done')),
	CONSTRAINT "proposals_second_confirmation_known" CHECK ("proposals"."second_confirmation" <@ ARRAY['target_team', 'requester_side', 'claimant']::text[]),
	CONSTRAINT "proposals_accountable_side_known" CHECK ("proposals"."accountable_side" IN ('requester_side', 'target_team')),
	CONSTRAINT "proposals_actor_kind_known" CHECK ("proposals"."actor_kind" IN ('agent', 'web_session', 'integration')),
	CONSTRAINT "proposals_surface_known" CHECK ("proposals"."surface" IS NULL OR "proposals"."surface" IN ('web', 'mcp', 'cli', 'api', 'github', 'jira')),
	CONSTRAINT "proposals_change_is_object" CHECK (json_typeof("proposals"."change") = 'object'),
	CONSTRAINT "proposals_packet_changes_have_a_base" CHECK (("proposals"."kind" IN ('due_date', 'scope')) = ("proposals"."base_revision" IS NOT NULL)),
	CONSTRAINT "proposals_state_known" CHECK ("proposals"."state" IN ('pending', 'applied', 'rejected', 'withdrawn', 'expired', 'cancelled')),
	CONSTRAINT "proposals_expire_after_7_days" CHECK ("proposals"."expires_at" = "proposals"."created_at" + interval '7 days')
);
--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_accountable_user_fk" FOREIGN KEY ("org_id","accountable_user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proposals_request_id" ON "proposals" USING btree ("org_id","request_id");