DO $body$
BEGIN
  -- A ; inside the block does not end the statement.
  UPDATE "things" SET "name" = 'x' WHERE false;
END
$body$;
