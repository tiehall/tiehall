CREATE TABLE "security_event_origins" (
	"org_id" uuid NOT NULL,
	"event_number" bigint NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	CONSTRAINT "security_event_origins_org_id_event_number_pk" PRIMARY KEY("org_id","event_number")
);
--> statement-breakpoint
ALTER TABLE "security_event_origins" ADD CONSTRAINT "security_event_origins_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event_origins" ADD CONSTRAINT "security_event_origins_event_fk" FOREIGN KEY ("org_id","event_number") REFERENCES "public"."events"("org_id","number") ON DELETE no action ON UPDATE no action;