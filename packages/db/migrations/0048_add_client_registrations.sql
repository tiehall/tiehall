CREATE TABLE "oauth_client_registrations" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"ip_address" "inet",
	"registered_at" timestamp with time zone NOT NULL,
	"client_id" text,
	CONSTRAINT "oauth_client_registrations_org_id_id_pk" PRIMARY KEY("org_id","id")
);
--> statement-breakpoint
ALTER TABLE "oauth_client_registrations" ADD CONSTRAINT "oauth_client_registrations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_client_registrations" ADD CONSTRAINT "oauth_client_registrations_client_fk" FOREIGN KEY ("org_id","client_id") REFERENCES "public"."oauth_clients"("org_id","client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_client_registrations_address_time" ON "oauth_client_registrations" USING btree ("org_id","ip_address","registered_at");--> statement-breakpoint
CREATE INDEX "oauth_client_registrations_client" ON "oauth_client_registrations" USING btree ("org_id","client_id");