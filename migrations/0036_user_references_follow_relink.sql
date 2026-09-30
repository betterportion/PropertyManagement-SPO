ALTER TABLE "assets" DROP CONSTRAINT "assets_snoozed_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" DROP CONSTRAINT "assets_assigned_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "contact_notes" DROP CONSTRAINT "contact_notes_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "deposit_deductions" DROP CONSTRAINT "deposit_deductions_recorded_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "maintenance_request_comments" DROP CONSTRAINT "maintenance_request_comments_author_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "property_setup_items" DROP CONSTRAINT "property_setup_items_set_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "resident_documents" DROP CONSTRAINT "resident_documents_recorded_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assigned_to_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_completed_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "user_permissions" DROP CONSTRAINT "user_permissions_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "walkthrough_items" DROP CONSTRAINT "walkthrough_items_dismissed_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_snoozed_by_user_id_users_id_fk" FOREIGN KEY ("snoozed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "contact_notes" ADD CONSTRAINT "contact_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "deposit_deductions" ADD CONSTRAINT "deposit_deductions_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "maintenance_request_comments" ADD CONSTRAINT "maintenance_request_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "property_setup_items" ADD CONSTRAINT "property_setup_items_set_by_user_id_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "resident_documents" ADD CONSTRAINT "resident_documents_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_to_user_id_users_id_fk" FOREIGN KEY ("assigned_to_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "user_permissions" ADD CONSTRAINT "user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD CONSTRAINT "walkthrough_items_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE cascade;