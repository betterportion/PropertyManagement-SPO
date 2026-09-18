import { describe, it, expect } from "vitest";
import { csvCell } from "./csv";

describe("csvCell", () => {
  it("leaves ordinary text alone and quotes commas, quotes and newlines", () => {
    expect(csvCell("Ann")).toBe("Ann");
    expect(csvCell(null)).toBe("");
    expect(csvCell("Lee, Ann")).toBe('"Lee, Ann"');
    expect(csvCell('Bob "B"')).toBe('"Bob ""B"""');
  });

  it("keeps a cell a spreadsheet would run as a formula as text", () => {
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });
});
