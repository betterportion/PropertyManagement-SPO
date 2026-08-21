import { describe, it, expect } from "vitest";
import {
  expectedSchema,
  compareSchema,
  tablesAddedAfter,
  tagMatching,
} from "../baseline-migrations";

/**
 * These run against the real migration files rather than fixtures, because the
 * thing that broke here was the mismatch between what the check expected and
 * what this project's actual migrations do.
 *
 * The bug: the check read only CREATE TABLE, so a column dropped by a later
 * migration was still expected to be present. That made an existing database --
 * the only kind anyone would ever baseline -- fail the check, get sent to
 * `db:migrate`, and fail again there on a table that already existed. The
 * documented upgrade path was a dead end.
 */
describe("expectedSchema", () => {
  const THROUGH_0000 = ["0000_baseline_current_schema"];
  const THROUGH_0002 = [
    "0000_baseline_current_schema",
    "0001_add_uploads_table",
    "0002_drop_monday_item_id",
  ];

  it("expects a column that exists at that point in history", () => {
    expect(expectedSchema(THROUGH_0000).get("maintenance_requests")).toContain("monday_item_id");
  });

  it("stops expecting a column once a later migration drops it", () => {
    expect(expectedSchema(THROUGH_0002).get("maintenance_requests")).not.toContain(
      "monday_item_id",
    );
  });

  it("keeps the rest of the table after a column is dropped", () => {
    const columns = expectedSchema(THROUGH_0002).get("maintenance_requests");
    expect(columns).toContain("id");
    expect(columns).toContain("region");
    expect(columns).toContain("submitted_by");
  });

  it("includes tables added by a later migration", () => {
    expect(expectedSchema(THROUGH_0000).has("uploads")).toBe(false);
    expect(expectedSchema(THROUGH_0002).has("uploads")).toBe(true);
  });

  it("reads columns but not table-level constraints", () => {
    const uploads = expectedSchema(THROUGH_0002).get("uploads")!;
    expect(uploads).toContain("storage_key");
    expect(uploads).toContain("original_name");
    // "CONSTRAINT "uploads_storage_key_unique" UNIQUE(...)" is not a column.
    expect([...uploads].some((c) => c.includes("unique"))).toBe(false);
  });

  it("describes the whole schema, so the check cannot silently pass on an empty set", () => {
    // 13 application tables plus `sessions`. The fifteenth table the runbook
    // tells you to expect, `audit_log`, arrives in 0003.
    expect(expectedSchema(THROUGH_0002).size).toBe(14);
    expect(expectedSchema([...THROUGH_0002, "0003_add_audit_log"]).size).toBe(15);
  });
});

/**
 * The two ways a wrong tag can write a migration history that is not true.
 * Both end the same way -- the next `db:migrate` fails, or a column is left
 * behind with nothing remaining to remove it -- and neither is obvious from the
 * command's output, so both must be refused rather than recorded.
 *
 * `present` is built from the migration files themselves, so these describe
 * real databases at real points in this project's history.
 */
describe("refusing a tag the database does not match", () => {
  const ALL = [
    "0000_baseline_current_schema",
    "0001_add_uploads_table",
    "0002_drop_monday_item_id",
    "0003_add_audit_log",
  ];

  /** What the check sees when it looks at a database at the given point. */
  const databaseAt = (through: number) => expectedSchema(ALL.slice(0, through + 1));

  const problemsFor = (databaseThrough: number, claimedTag: number) =>
    compareSchema(
      expectedSchema(ALL.slice(0, claimedTag + 1)),
      databaseAt(databaseThrough),
      tablesAddedAfter(ALL, claimedTag),
    );

  it("accepts the tag that genuinely matches", () => {
    for (let point = 0; point < ALL.length; point++) {
      expect(problemsFor(point, point)).toEqual([]);
    }
  });

  it("refuses a tag that is behind the database, which would fail the next migrate", () => {
    // The current database, claimed as 0000. Every 0000 column is present, so
    // only the already-existing `uploads` table gives it away -- and if it did
    // not, `db:migrate` would then try to create that table.
    const problems = problemsFor(2, 0);
    expect(problems.join(" ")).toContain("uploads");
    expect(problems.join(" ")).toContain("further along");
  });

  it("refuses a tag that is ahead of the database, which would strand a column", () => {
    // A database that still has monday_item_id, claimed as 0002 (which drops
    // it). Recording that would leave the column with nothing left to remove it.
    const problems = problemsFor(1, 2);
    expect(problems.join(" ")).toContain("monday_item_id");
    expect(problems.join(" ")).toContain("has not reached that migration yet");
  });

  it("refuses an empty database at every tag", () => {
    for (let tag = 0; tag < ALL.length; tag++) {
      expect(compareSchema(expectedSchema(ALL.slice(0, tag + 1)), new Map(), new Set())).not.toEqual(
        [],
      );
    }
  });

  it("names the tag that would have worked", () => {
    expect(tagMatching(ALL, databaseAt(2))).toBe("0002_drop_monday_item_id");
    expect(tagMatching(ALL, databaseAt(0))).toBe("0000_baseline_current_schema");
  });

  it("names no tag when the database matches no point in history", () => {
    const drifted = databaseAt(2);
    drifted.set("something_nobody_migrated", new Set(["id"]));
    // An unknown extra table is not a mismatch by itself -- no migration claims
    // it -- so the real check for drift is a column that does not belong.
    expect(tagMatching(ALL, drifted)).toBe("0002_drop_monday_item_id");

    drifted.get("users")!.add("column_added_by_hand");
    expect(tagMatching(ALL, drifted)).toBeUndefined();
  });
});
