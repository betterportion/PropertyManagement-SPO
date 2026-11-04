ALTER TABLE "billing_records" ADD COLUMN "building_address" varchar;--> statement-breakpoint
ALTER TABLE "maintenance_contacts" ADD COLUMN "service_cities" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Each existing contact serves the city of the house it was filed against, in
-- the "City, ST" form cityLabel (client/src/lib/contactCities.ts) writes.
UPDATE "maintenance_contacts" AS c SET "service_cities" = ARRAY[p."city" || ', ' || p."state"] FROM "properties" AS p WHERE p."address" = c."building_address" AND c."service_cities" = '{}'::text[];
