-- Runs once when the database is created (see schema-floor-above-image.yaml): the record the migrate step
-- keeps, holding a contract step that release 99.0.0 ran.
CREATE SCHEMA tiehall_migrate;
CREATE TABLE tiehall_migrate.applied_migrations (
  id text PRIMARY KEY,
  hash text NOT NULL,
  release text NOT NULL,
  contract_after text,
  applied_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tiehall_migrate.applied_migrations (id, hash, release, contract_after)
VALUES ('9999_drop_what_98_replaced', 'a migration of a later release', '99.0.0', '98.0.0');
