import { describe, it, expect } from "vitest";
import { pendingMigrationProblem } from "../check-pending-migrations";

describe("pendingMigrationProblem", () => {
  it("lets the build go ahead when every migration is applied", () => {
    expect(pendingMigrationProblem(46, 46)).toBeNull();
  });

  it("stops the build while a migration is pending, naming the script to run", () => {
    expect(pendingMigrationProblem(47, 46)).toMatch(/1 migration\(s\) not yet applied.*deploy-production\.sh/);
  });

  it("stops the build when the database is ahead of the code", () => {
    expect(pendingMigrationProblem(45, 46)).toMatch(/ahead of the code/);
  });
});
