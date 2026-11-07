/**
 * Ordered chart series colors — §2.4 of the SPO design system.
 * Always import these; never hardcode a hex in a chart, or dark mode breaks.
 *
 * chart-3 (green) and chart-4 (amber) carry meaning — positive/on-pace and
 * warning/behind. Do not use them as arbitrary categorical fills.
 */
export const CHART_COLORS = [
  "hsl(var(--chart-1))", // SPO Blue (light) / near-white (dark) — primary series
  "hsl(var(--chart-2))", // SPO Red — comparison series
  "hsl(var(--chart-3))", // Green — positive / on-pace
  "hsl(var(--chart-4))", // Amber — warning / behind
  "hsl(var(--chart-5))", // Purple — categorical
  "hsl(var(--chart-6))", // Cyan — categorical
] as const;
