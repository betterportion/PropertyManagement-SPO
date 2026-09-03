/**
 * The vocabulary of a dashboard action item.
 *
 * In `shared/` because the server classifies items and the client decides how
 * to resolve one, and those two answers have to be about the same set of
 * kinds. They were separate copies once: the server grew `setup` and `asset`
 * sources, the client's `resolveRequest` switch did not, and because that
 * switch has no default it returned `undefined` for the new kinds — which the
 * caller then read `.actionLabel` off, crashing the Tasks page and the
 * dashboard's list for any region with an unfinished setup checklist. Two
 * copies of one union is what let that compile.
 */

export const ACTION_ITEM_SOURCES = [
  "schedule",
  "rent",
  "deposit",
  "task",
  "lease",
  "setup",
  "asset",
] as const;

export type ActionItemSource = (typeof ACTION_ITEM_SOURCES)[number];

export type ActionItemCategory = "property" | "safety" | "finance" | "general";
