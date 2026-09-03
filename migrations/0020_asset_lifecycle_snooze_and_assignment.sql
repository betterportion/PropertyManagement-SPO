ALTER TABLE "assets" ADD COLUMN "acquisition_date" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "expected_lifespan_years" integer;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "replacement_due_date" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "snoozed_until" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "snooze_reason" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "snoozed_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "snoozed_at" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "current_value" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "valued_on" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "assigned_resident_id" varchar;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "assigned_user_id" varchar;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "assigned_to_name" varchar;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "expected_return_date" timestamp;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "acquisition_notes" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "supplier_contact_id" varchar;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_snoozed_by_user_id_users_id_fk" FOREIGN KEY ("snoozed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_resident_id_residents_id_fk" FOREIGN KEY ("assigned_resident_id") REFERENCES "public"."residents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_supplier_contact_id_maintenance_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."maintenance_contacts"("id") ON DELETE set null ON UPDATE no action;