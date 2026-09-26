-- Every table carries org_id in its key and in each foreign key.
CREATE TABLE "teams" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "teams_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "teams_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id")
);
CREATE TABLE "members" (
	"org_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "members_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs" ("id"),
	CONSTRAINT "members_org_id_team_id_teams_org_id_id_fk" FOREIGN KEY ("org_id", "team_id") REFERENCES "teams" ("org_id", "id")
);
-- One row per org, keyed by org_id alone.
CREATE TABLE "counters" (
	"org_id" uuid PRIMARY KEY NOT NULL REFERENCES "orgs" ("id"),
	"value" bigint NOT NULL
);
