-- "org_id" is there, but may be null, is not part of the primary key, and does not reference orgs.
CREATE TABLE "labels" (
	"org_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL
);
