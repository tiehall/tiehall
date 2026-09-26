CREATE TABLE "agent_token_writes" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"written_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_token_writes_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "agent_token_writes_token_length" CHECK (char_length("agent_token_writes"."token") BETWEEN 1 AND 2200)
);
--> statement-breakpoint
CREATE TABLE "agent_write_days" (
	"org_id" uuid NOT NULL,
	"day" date NOT NULL,
	"writes" integer NOT NULL,
	CONSTRAINT "agent_write_days_org_id_day_pk" PRIMARY KEY("org_id","day"),
	CONSTRAINT "agent_write_days_writes_not_negative" CHECK ("agent_write_days"."writes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "install_settings" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"daily_write_budget" integer DEFAULT 5000 NOT NULL,
	CONSTRAINT "install_settings_daily_write_budget_range" CHECK ("install_settings"."daily_write_budget" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
ALTER TABLE "agent_token_writes" ADD CONSTRAINT "agent_token_writes_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_write_days" ADD CONSTRAINT "agent_write_days_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "install_settings" ADD CONSTRAINT "install_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_token_writes_token_time" ON "agent_token_writes" USING btree ("org_id","token","written_at");