-- migrate: no-transaction
CREATE INDEX CONCURRENTLY IF NOT EXISTS "things_kind" ON "things" ("kind");
