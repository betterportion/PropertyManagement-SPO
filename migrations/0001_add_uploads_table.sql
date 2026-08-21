CREATE TABLE "uploads" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" varchar NOT NULL,
	"original_name" varchar NOT NULL,
	"content_type" varchar NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by" varchar NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key")
);
