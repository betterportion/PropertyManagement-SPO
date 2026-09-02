CREATE TABLE "property_setup_items" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_id" varchar NOT NULL,
	"item_key" varchar NOT NULL,
	"status" varchar DEFAULT 'open' NOT NULL,
	"note" text,
	"set_by_user_id" varchar,
	"set_at" timestamp,
	"region" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lease_document_url" varchar;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "maintenance_portal_url" varchar;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "rental_company_contact_id" varchar;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "responsible_contact_id" varchar;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "photo_url" varchar;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "property_setup_items" ADD CONSTRAINT "property_setup_items_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_setup_items" ADD CONSTRAINT "property_setup_items_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_property_setup_item" ON "property_setup_items" USING btree ("property_id","item_key");--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_rental_company_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("rental_company_contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_responsible_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("responsible_contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;