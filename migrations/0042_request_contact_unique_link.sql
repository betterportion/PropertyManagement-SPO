-- A double-click could link one contractor to one request twice, and each link
-- counts as a visit in the contractor rollup. Keep the earliest link of each
-- pair, then make a second one impossible.
DELETE FROM "request_contacts"
WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", ROW_NUMBER() OVER (
			PARTITION BY "request_id", "contact_id" ORDER BY "created_at" NULLS LAST, "id"
		) AS "n"
		FROM "request_contacts"
	) AS "ranked"
	WHERE "n" > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX "IDX_request_contact_link" ON "request_contacts" USING btree ("request_id","contact_id");
