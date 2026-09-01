-- Both nullable: a roster imported from a spreadsheet routinely has neither,
-- and a NOT NULL here would mean inventing a value or dropping the row.
ALTER TABLE "residents" ADD COLUMN "phone" varchar;--> statement-breakpoint
ALTER TABLE "residents" ADD COLUMN "notes" text;
