-- The expand step: 1.3.0 reads and writes "title" and no longer reads "name".
ALTER TABLE "things" ADD COLUMN "title" text;
