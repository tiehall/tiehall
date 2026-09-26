CREATE TABLE "team_members" (
	"org_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_org_id_team_id_user_id_pk" PRIMARY KEY("org_id","team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_org_id_id_pk" PRIMARY KEY("org_id","id"),
	CONSTRAINT "teams_name_length" CHECK (char_length("teams"."name") BETWEEN 1 AND 100)
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_member_fk" FOREIGN KEY ("org_id","user_id") REFERENCES "public"."members"("org_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_members_user_id" ON "team_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "teams_key" ON "teams" USING btree ("org_id","key");