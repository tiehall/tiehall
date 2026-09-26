CREATE TABLE "agent_opened_requests" (
	"org_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"requesting_team_id" uuid NOT NULL,
	"target_team_id" uuid NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_opened_requests_org_id_request_id_pk" PRIMARY KEY("org_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "agent_opened_requests" ADD CONSTRAINT "agent_opened_requests_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_opened_requests" ADD CONSTRAINT "agent_opened_requests_request_fk" FOREIGN KEY ("org_id","request_id") REFERENCES "public"."requests"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_opened_requests" ADD CONSTRAINT "agent_opened_requests_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_opened_requests" ADD CONSTRAINT "agent_opened_requests_requesting_team_fk" FOREIGN KEY ("org_id","requesting_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_opened_requests" ADD CONSTRAINT "agent_opened_requests_target_team_fk" FOREIGN KEY ("org_id","target_team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_opened_requests_user_time" ON "agent_opened_requests" USING btree ("org_id","user_id","opened_at");--> statement-breakpoint
CREATE INDEX "agent_opened_requests_pair_time" ON "agent_opened_requests" USING btree ("org_id","requesting_team_id","target_team_id","opened_at");