CREATE TABLE "personal_access_token_reminders" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"days_before" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"emailed_at" timestamp with time zone,
	CONSTRAINT "personal_access_token_reminders_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "personal_access_token_reminders_days_known" CHECK ("personal_access_token_reminders"."days_before" IN (14, 3))
);
--> statement-breakpoint
ALTER TABLE "personal_access_token_reminders" ADD CONSTRAINT "personal_access_token_reminders_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_token_reminders" ADD CONSTRAINT "personal_access_token_reminders_token_fk" FOREIGN KEY ("org_id","token_id") REFERENCES "public"."personal_access_tokens"("org_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_token_reminders" ADD CONSTRAINT "personal_access_token_reminders_user_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_token_reminders_token_days" ON "personal_access_token_reminders" USING btree ("org_id","token_id","days_before");--> statement-breakpoint
CREATE INDEX "personal_access_token_reminders_user" ON "personal_access_token_reminders" USING btree ("org_id","user_id","created_at");