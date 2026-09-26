-- "teams" is keyed right; "members" points at a team by its id alone, so a member could name another org's team.
CREATE TABLE "teams" (
	"org_id" uuid NOT NULL REFERENCES "orgs" ("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	CONSTRAINT "teams_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "teams_id_unique" UNIQUE ("id")
);
CREATE TABLE "members" (
	"org_id" uuid NOT NULL REFERENCES "orgs" ("id"),
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	CONSTRAINT "members_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
	CONSTRAINT "members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams" ("id")
);
