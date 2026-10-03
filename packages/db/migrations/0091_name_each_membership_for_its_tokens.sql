CREATE SEQUENCE "public"."members_token_generation_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "members" ADD COLUMN "token_generation" bigint;--> statement-breakpoint
ALTER TABLE "members" ALTER COLUMN "token_generation" SET DEFAULT nextval('members_token_generation_seq');
