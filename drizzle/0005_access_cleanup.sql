CREATE UNIQUE INDEX "memberships_one_owner_uq" ON "memberships" USING btree ("property_id") WHERE "memberships"."access" = 'owner';--> statement-breakpoint
ALTER TABLE "memberships" DROP COLUMN "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_access_chk" CHECK ("memberships"."access" in ('owner', 'admin', 'staff'));--> statement-breakpoint
DROP TYPE "public"."role";