CREATE TABLE "api_consumers" (
	"org_id" uuid NOT NULL,
	"api_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"declared_by" uuid NOT NULL,
	"declared_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_consumers_org_id_api_id_team_id_pk" PRIMARY KEY("org_id","api_id","team_id"),
	CONSTRAINT "api_consumers_confirmed_after_declared" CHECK ("api_consumers"."last_confirmed_at" >= "api_consumers"."declared_at")
);
--> statement-breakpoint
ALTER TABLE "api_consumers" ADD CONSTRAINT "api_consumers_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_consumers" ADD CONSTRAINT "api_consumers_api_fk" FOREIGN KEY ("org_id","api_id") REFERENCES "public"."apis"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_consumers" ADD CONSTRAINT "api_consumers_team_fk" FOREIGN KEY ("org_id","team_id") REFERENCES "public"."teams"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_consumers" ADD CONSTRAINT "api_consumers_declared_by_fk" FOREIGN KEY ("org_id","declared_by") REFERENCES "public"."users"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_consumers_team" ON "api_consumers" USING btree ("org_id","team_id");