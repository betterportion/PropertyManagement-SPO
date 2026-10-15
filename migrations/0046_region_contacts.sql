CREATE TABLE "region_contacts" (
	"region" varchar PRIMARY KEY NOT NULL,
	"name" varchar NOT NULL,
	"phone" varchar NOT NULL,
	"email" varchar,
	"hours" varchar,
	"updated_by_email" varchar,
	"updated_at" timestamp DEFAULT now()
);
