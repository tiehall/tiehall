CREATE TABLE "tracker_changes" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"mirror_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"change" text NOT NULL,
	"reason" text,
	"actor" jsonb,
	"assignees" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracker_changes_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "tracker_changes_change_known" CHECK ("tracker_changes"."change" IN ('closed', 'reopened', 'assignees_changed')),
	CONSTRAINT "tracker_changes_reason_for_closes" CHECK (("tracker_changes"."change" = 'closed') = ("tracker_changes"."reason" IS NOT NULL) AND ("tracker_changes"."reason" IS NULL OR "tracker_changes"."reason" IN ('completed', 'not_planned', 'duplicate'))),
	CONSTRAINT "tracker_changes_actor_is_object" CHECK ("tracker_changes"."actor" IS NULL OR jsonb_typeof("tracker_changes"."actor") = 'object'),
	CONSTRAINT "tracker_changes_assignees_for_assignments" CHECK (("tracker_changes"."change" = 'assignees_changed') = ("tracker_changes"."assignees" IS NOT NULL) AND ("tracker_changes"."assignees" IS NULL OR jsonb_typeof("tracker_changes"."assignees") = 'array'))
);
--> statement-breakpoint
ALTER TABLE "tracker_changes" ADD CONSTRAINT "tracker_changes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_changes" ADD CONSTRAINT "tracker_changes_mirror_fk" FOREIGN KEY ("org_id","mirror_id") REFERENCES "public"."mirrors"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_changes" ADD CONSTRAINT "tracker_changes_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tracker_changes_request" ON "tracker_changes" USING btree ("org_id","request_id");