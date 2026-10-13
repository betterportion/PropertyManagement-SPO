/**
 * The close-out: what the RA records when a request is marked completed
 * (launch readiness 2.4, docs/LAUNCH_READINESS_ROUND.md decisions 6–12).
 *
 * Four yes/no facts and a note, asked only when a contractor is linked, and
 * then required; "what was done", always offered and never required. No
 * rating, no score: the contractor page shows counts and the dated history.
 *
 * The questions, the body shape and the refusal sentence live here so the
 * server and the edit dialog cannot disagree about what is required, and
 * the sentence on screen is the server's own.
 */
import { z } from "zod";

export const CLOSEOUT_QUESTIONS = [
  { key: "firstVisit", label: "Finished on the first visit", rollup: "Finished on first visit" },
  { key: "quoteMatched", label: "Final cost matched the quote", rollup: "Cost matched quote" },
  { key: "callback", label: "Needed a callback", rollup: "Needed a callback" },
  { key: "wouldUseAgain", label: "Would use them again", rollup: "Would use again" },
] as const;

export type CloseoutQuestionKey = (typeof CLOSEOUT_QUESTIONS)[number]["key"];

/** The four answers and the note, as the edit dialog sends them. */
export const closeoutAnswersSchema = z.object({
  firstVisit: z.boolean().nullable().optional(),
  quoteMatched: z.boolean().nullable().optional(),
  callback: z.boolean().nullable().optional(),
  wouldUseAgain: z.boolean().nullable().optional(),
  note: z.string().max(4000, "Keep the note under 4,000 characters").nullable().optional(),
});

export type CloseoutAnswers = z.infer<typeof closeoutAnswersSchema>;

/**
 * The whole close-out as sent with the status change: the answers, plus
 * "what was done", which becomes a thread comment (internal unless said
 * otherwise) with one optional file already uploaded through the request's
 * attachment route.
 */
export const closeoutFromClientSchema = closeoutAnswersSchema.extend({
  whatWasDone: z.string().max(10000, "Keep it under 10,000 characters").nullable().optional(),
  whatWasDoneInternal: z.boolean().optional(),
  attachmentUrl: z.string().nullable().optional(),
  attachmentName: z.string().max(255).nullable().optional(),
});

export type CloseoutFromClient = z.infer<typeof closeoutFromClientSchema>;

/** "Dave's Plumbing", "Dave's Plumbing and Acme Electric", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The answer that reads well for the contractor, so a screen can colour a "yes" to "needed a callback" as the bad news it is. */
export const GOOD_ANSWER: Record<CloseoutQuestionKey, boolean> = { firstVisit: true, quoteMatched: true, callback: false, wouldUseAgain: true };

export function isGoodAnswer(key: CloseoutQuestionKey, value: boolean | null | undefined): boolean {
  return typeof value === "boolean" && value === GOOD_ANSWER[key];
}

/** True when all four were answered, which is what the contractor rollup counts. */
export function answeredAllFour(answers: Partial<Record<CloseoutQuestionKey, boolean | null | undefined>>): boolean {
  return CLOSEOUT_QUESTIONS.every(({ key }) => typeof answers[key] === "boolean");
}

/**
 * Pure: why this close-out cannot complete the request, as one sentence for
 * the screen, or null when it can. With no contractor linked nothing is
 * required, so everything may be empty.
 */
export function closeoutProblem(answers: CloseoutAnswers | null | undefined, contractorNames: readonly string[]): string | null {
  if (contractorNames.length === 0) return null;
  const given = answers ?? {};
  const missing = CLOSEOUT_QUESTIONS.filter(({ key }) => typeof given[key] !== "boolean");
  const noteBlank = !given.note?.trim();
  if (missing.length === 0 && !noteBlank) return null;
  const who = joinNames(contractorNames);
  if (missing.length === 0) return `Before this request is marked completed, add a note on how it went with ${who}.`;
  const questions = missing.length === CLOSEOUT_QUESTIONS.length ? "the four questions" : `"${missing.map((q) => q.label).join('", "')}"`;
  return noteBlank
    ? `Before this request is marked completed, answer ${questions} about ${who} and add a note on how it went.`
    : `Before this request is marked completed, answer ${questions} about ${who}.`;
}
