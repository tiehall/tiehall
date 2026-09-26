CREATE TABLE "team_key_aliases" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"team_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_key_aliases_org_id_key_pk" PRIMARY KEY("org_id","key"),
	CONSTRAINT "team_key_aliases_key_format" CHECK ("team_key_aliases"."key" ~ '^[A-Z][A-Z0-9]{1,9}$')
);
--> statement-breakpoint
ALTER TABLE "team_key_aliases" ADD CONSTRAINT "team_key_aliases_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_key_aliases" ADD CONSTRAINT "team_key_aliases_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_key_aliases_team_id" ON "team_key_aliases" USING btree ("org_id","team_id");--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_key_format" CHECK ("teams"."key" ~ '^[A-Z][A-Z0-9]{1,9}$');