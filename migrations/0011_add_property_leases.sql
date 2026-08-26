ALTER TABLE "properties" ADD COLUMN "ownership" varchar DEFAULT 'owned' NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lease_start_date" timestamp;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lease_end_date" timestamp;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "lease_renewal_date" timestamp;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "renewal_decision" varchar DEFAULT 'undecided' NOT NULL;