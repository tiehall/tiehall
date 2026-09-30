CREATE TABLE "oauth_device_codes" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"oauth_client_id" text,
	"scope" text,
	"resources" text[],
	"requested_from" "inet",
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_device_codes_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "oauth_device_codes_status_known" CHECK ("oauth_device_codes"."status" IN ('pending', 'approved', 'denied'))
);
--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_device_codes" ADD CONSTRAINT "oauth_device_codes_client_fk" FOREIGN KEY ("org_id","oauth_client_id") REFERENCES "public"."oauth_clients"("org_id","client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_device_code" ON "oauth_device_codes" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_device_codes_user_code" ON "oauth_device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oauth_device_codes_expires_at" ON "oauth_device_codes" USING btree ("org_id","expires_at");