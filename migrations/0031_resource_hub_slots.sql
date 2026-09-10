ALTER TABLE "resource_links" ADD COLUMN "slot_key" varchar;--> statement-breakpoint
ALTER TABLE "resource_links" ADD CONSTRAINT "resource_links_slot_key_unique" UNIQUE("slot_key");