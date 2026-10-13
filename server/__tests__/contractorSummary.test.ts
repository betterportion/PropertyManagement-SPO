/**
 * The contractor rollup (launch readiness 2.4): counts and the dated history,
 * never an average. The brief's nine-job fixture, exactly.
 */
import { describe, it, expect } from "vitest";
import { contractorSummary, countLine, type CloseoutRow } from "../contractorSummary";
import { closeoutProblem, joinNames } from "@shared/closeouts";
import type { RequestCloseout } from "@shared/schema";

const day = (n: number) => new Date(Date.UTC(2027, 0, n));

function row(n: number, answers: Partial<Pick<RequestCloseout, "firstVisit" | "quoteMatched" | "callback" | "wouldUseAgain">>, note = `Job ${n}`): CloseoutRow {
  return {
    closeout: {
      id: `co-${n}`,
      requestId: `req-${n}`,
      firstVisit: true,
      quoteMatched: true,
      callback: false,
      wouldUseAgain: true,
      ...answers,
      note,
      completedAt: day(n),
      completedByEmail: "ra@spo.org",
      completedByName: "Michael Nichols",
      updatedAt: day(n),
    },
    request: { id: `req-${n}`, title: `Repair ${n}`, buildingAddress: "1 Main St", region: "West Central" },
  };
}

/**
 * Nine completed jobs: first-visit yes ×7 no ×2, quote matched yes ×8 no ×1,
 * callback yes ×2 no ×7, would use again yes ×8 no ×1.
 */
const NINE: CloseoutRow[] = [
  row(1, { firstVisit: false, callback: true }),
  row(2, { firstVisit: false, callback: true }),
  row(3, { quoteMatched: false }),
  row(4, { wouldUseAgain: false }),
  row(5, {}),
  row(6, {}),
  row(7, {}),
  row(8, {}),
  row(9, {}),
];

describe("contractorSummary", () => {
  it("passes the brief's fixture exactly", () => {
    const summary = contractorSummary(NINE);
    expect(summary.answered).toBe(9);
    expect(summary.counts.map(countLine)).toEqual([
      "Finished on first visit: 7 of 9",
      "Cost matched quote: 8 of 9",
      "Needed a callback: 2 of 9",
      "Would use again: 8 of 9",
    ]);
  });

  it("lists the nine beneath, newest first, each with its note and a link to the request", () => {
    const { history } = contractorSummary(NINE);
    expect(history).toHaveLength(9);
    expect(history.map((job) => job.requestId)).toEqual(["req-9", "req-8", "req-7", "req-6", "req-5", "req-4", "req-3", "req-2", "req-1"]);
    expect(history[0]).toMatchObject({ title: "Repair 9", note: "Job 9", completedByName: "Michael Nichols", answers: { firstVisit: true, callback: false } });
  });

  it("has no average and no score anywhere in it", () => {
    const summary = contractorSummary(NINE) as unknown as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual(["answered", "counts", "history"]);
    for (const count of summary.counts as object[]) expect(Object.keys(count).sort()).toEqual(["key", "label", "of", "yes"]);
  });

  it("counts a close-out only when all four were answered, but still lists it", () => {
    const partial = row(10, { firstVisit: null, quoteMatched: null, callback: null, wouldUseAgain: null }, "Completed before a contractor was linked");
    const summary = contractorSummary([...NINE, partial]);
    expect(summary.answered).toBe(9);
    expect(summary.counts.map(countLine)[0]).toBe("Finished on first visit: 7 of 9");
    expect(summary.history).toHaveLength(10);
    expect(summary.history[0].answers).toEqual({ firstVisit: null, quoteMatched: null, callback: null, wouldUseAgain: null });
  });

  it("counts one job once however many rows name it", () => {
    const summary = contractorSummary([row(1, {}), row(1, {})]);
    expect(summary.answered).toBe(1);
    expect(summary.history).toHaveLength(1);
  });

  it("is empty, not undefined, for a contractor with nothing closed out", () => {
    expect(contractorSummary([])).toEqual({
      answered: 0,
      counts: [
        { key: "firstVisit", label: "Finished on first visit", yes: 0, of: 0 },
        { key: "quoteMatched", label: "Cost matched quote", yes: 0, of: 0 },
        { key: "callback", label: "Needed a callback", yes: 0, of: 0 },
        { key: "wouldUseAgain", label: "Would use again", yes: 0, of: 0 },
      ],
      history: [],
    });
  });
});

describe("closeoutProblem: what stops a completion (pure, shared with the screen)", () => {
  const full = { firstVisit: true, quoteMatched: true, callback: false, wouldUseAgain: true, note: "Fine work." };

  it("asks nothing when no contractor is linked, whatever was left empty", () => {
    expect(closeoutProblem(undefined, [])).toBeNull();
    expect(closeoutProblem({ note: "" }, [])).toBeNull();
  });

  it("passes four answers and a note", () => {
    expect(closeoutProblem(full, ["Dave's Plumbing"])).toBeNull();
  });

  it("names the contractor and the four questions when nothing was answered", () => {
    expect(closeoutProblem(undefined, ["Dave's Plumbing"])).toBe(
      "Before this request is marked completed, answer the four questions about Dave's Plumbing and add a note on how it went.",
    );
  });

  it("names just the unanswered question, and the note only when it is blank", () => {
    expect(closeoutProblem({ ...full, callback: null }, ["Dave's Plumbing"])).toBe(
      'Before this request is marked completed, answer "Needed a callback" about Dave\'s Plumbing.',
    );
    expect(closeoutProblem({ ...full, note: "  " }, ["Dave's Plumbing"])).toBe(
      "Before this request is marked completed, add a note on how it went with Dave's Plumbing.",
    );
    expect(closeoutProblem({ ...full, firstVisit: undefined, note: "" }, ["Dave's Plumbing", "Acme Electric"])).toBe(
      'Before this request is marked completed, answer "Finished on the first visit" about Dave\'s Plumbing and Acme Electric and add a note on how it went.',
    );
  });

  it("joins names the way a sentence does", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["A"])).toBe("A");
    expect(joinNames(["A", "B"])).toBe("A and B");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
  });
});
