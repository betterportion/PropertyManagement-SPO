ALTER TABLE "maintenance_requests" ADD COLUMN "walkthrough_item_id" varchar;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD COLUMN "dismissed_at" timestamp;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD COLUMN "dismiss_reason" text;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD COLUMN "dismissed_by_user_id" varchar;--> statement-breakpoint
ALTER TABLE "walkthrough_items" ADD CONSTRAINT "walkthrough_items_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;