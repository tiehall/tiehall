-- migrate: contract after 1.3.0
DELETE FROM "things" WHERE "name" IS NULL;
