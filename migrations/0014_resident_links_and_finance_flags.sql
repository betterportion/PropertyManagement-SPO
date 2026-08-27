ALTER TABLE "user_permissions" ADD COLUMN "can_view_financials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD COLUMN "can_manage_financials" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "property_id" varchar;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Finance was previously open to all staff via their role alone. The flags
-- narrow that to a grant, so existing staff must start with the grant they
-- already effectively had. New staff get it from computeDefaultPermissions.
UPDATE "user_permissions" SET "can_view_financials" = true, "can_manage_financials" = true
FROM "users"
WHERE "user_permissions"."user_id" = "users"."id" AND "users"."role" <> 'resident';
