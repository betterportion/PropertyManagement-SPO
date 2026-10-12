/**
 * What a contractor's close-outs add up to (launch readiness 2.4).
 *
 * Counts and the dated history, never an average and never a score: "Finished
 * on first visit: 7 of 9" tells an incoming RA something; a 3.8 does not.
 * Pure, like regionSummary.ts: the rows in, the summary out, so the brief's
 * fixture is its test. The caller passes only close-outs on requests it may
 * read, so the summary can never widen what somebody can see.
 *
 * The denominator is the close-outs that answered all four questions for this
 * contractor (decision 11). Jobs completed before the feature, or with no
 * contractor linked at the time, are not counted.
 */
import { answeredAllFour, CLOSEOUT_QUESTIONS, type CloseoutQuestionKey } from "@shared/closeouts";
import type { MaintenanceRequest, RequestCloseout } from "@shared/schema";

export interface CloseoutRow {
  closeout: RequestCloseout;
  request: Pick<MaintenanceRequest, "id" | "title" | "buildingAddress" | "region">;
}

export interface ContractorCount {
  key: CloseoutQuestionKey;
  /** "Finished on first visit" */
  label: string;
  yes: number;
  of: number;
}

export interface ContractorJob {
  requestId: string;
  title: string;
  buildingAddress: string;
  completedAt: Date;
  note: string | null;
  completedByName: string | null;
  answers: Record<CloseoutQuestionKey, boolean | null>;
}

export interface ContractorSummary {
  /** Close-outs that answered the four about this contractor. */
  answered: number;
  counts: ContractorCount[];
  /** Every close-out naming them, newest first, answered or not. */
  history: ContractorJob[];
}

export function contractorSummary(rows: readonly CloseoutRow[]): ContractorSummary {
  // One job is one job however many rows say so.
  const byRequest = new Map<string, CloseoutRow>();
  for (const row of rows) byRequest.set(row.request.id, row);
  const jobs = Array.from(byRequest.values());

  const answered = jobs.filter(({ closeout }) => answeredAllFour(closeout));
  const counts = CLOSEOUT_QUESTIONS.map(({ key, rollup }) => ({
    key,
    label: rollup,
    yes: answered.filter(({ closeout }) => closeout[key] === true).length,
    of: answered.length,
  }));

  const history = jobs
    .map(({ closeout, request }) => ({
      requestId: request.id,
      title: request.title,
      buildingAddress: request.buildingAddress,
      completedAt: new Date(closeout.completedAt),
      note: closeout.note,
      completedByName: closeout.completedByName,
      answers: Object.fromEntries(CLOSEOUT_QUESTIONS.map(({ key }) => [key, closeout[key] ?? null])) as Record<CloseoutQuestionKey, boolean | null>,
    }))
    .sort((a, b) => b.completedAt.getTime() - a.completedAt.getTime());

  return { answered: answered.length, counts, history };
}

/** "Finished on first visit: 7 of 9", the line the page prints. */
export function countLine(count: ContractorCount): string {
  return `${count.label}: ${count.yes} of ${count.of}`;
}
