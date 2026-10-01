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

/**
 * Regions the overview has no card for in v1. "National" is the catch-all for
 * a house outside every campus region; its card is hidden until the national
 * management view returns in v2 (docs/WORKFLOWS.md, "Deferred to v2"). Only the
 * card goes: the summary is still fetched, so the dashboard's totals and its
 * "Needs attention" lists still count those houses.
 */
export const REGIONS_WITHOUT_A_CARD: readonly string[] = ["National"];

/** The summaries the overview draws a card for. */
export function overviewCards<T extends { region: string }>(summaries: T[]): T[] {
  return summaries.filter((summary) => !REGIONS_WITHOUT_A_CARD.includes(summary.region));
}
