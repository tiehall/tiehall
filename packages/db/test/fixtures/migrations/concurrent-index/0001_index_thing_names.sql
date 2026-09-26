-- migrate: no-transaction
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "things_name" ON "things" ("name");
