-- Idempotent on purpose: this migration was renumbered from 0013 after main
-- gained its own 0013 in parallel, so a development database may have already
-- applied it under the old number. Re-running must be a no-op, not an error.
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "can_view_financials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN IF NOT EXISTS "can_manage_financials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "property_id" varchar;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "users" ADD CONSTRAINT "users_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
-- Finance was previously open to all staff via their role alone. The flags
-- narrow that to a grant, so existing staff must start with the grant they
-- already effectively had. New staff get it from computeDefaultPermissions.
UPDATE "user_permissions" SET "can_view_financials" = true, "can_manage_financials" = true
FROM "users"
WHERE "user_permissions"."user_id" = "users"."id" AND "users"."role" <> 'resident';
