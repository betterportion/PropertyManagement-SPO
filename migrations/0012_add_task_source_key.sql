ALTER TABLE "tasks" ADD COLUMN "source_key" varchar;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_key_unique" UNIQUE("source_key");