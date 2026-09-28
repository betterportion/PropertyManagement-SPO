/**
 * What a region card on the leadership overview may claim. The server gates
 * every count a caller cannot see to 0 and names those sources in `hidden`
 * (server/regionSummary.ts); this decides what the card says about them.
 *
 * Only the sources that make up the attention score can stop "All clear".
 * Unpaid rent is reported beside the score, never inside it, and the finance
 * flags default to off, so letting a hidden rent count block "All clear"
 * would mean most regional administrators never see it on any region.
 */
export const SCORE_SOURCES = ["maintenance", "schedule", "lease"] as const;

/** True when some of the attention score's own counts are hidden from this caller. */
export function scoreCountsHidden(hidden: string[]): boolean {
  return hidden.some((source) => (SCORE_SOURCES as readonly string[]).includes(source));
}

/** "All clear" only when the score is zero and none of its counts are hidden. */
export function isAllClear(summary: { attentionScore: number; hidden: string[] }): boolean {
  return summary.attentionScore === 0 && !scoreCountsHidden(summary.hidden);
}
