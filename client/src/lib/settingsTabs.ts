/**
 * The tabs on the Settings page, and which one a link into a section opens.
 *
 * Dashboard action items link to `/settings#roster`, `#email-health` and
 * `#quickbooks`, and QuickBooks sends an admin back to `#quickbooks`. Those
 * cards live on a tab that is not the first, so the hash picks the tab or the
 * link lands on a page without the card it promised.
 */
export const SETTINGS_TABS = ["people", "setup", "activity", "guide"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_FOR_SECTION: Record<string, SettingsTab> = {
  "#quickbooks": "setup",
  "#roster": "setup",
  "#email-health": "activity",
};

export function settingsTabForHash(hash: string): SettingsTab {
  return TAB_FOR_SECTION[hash] ?? "people";
}

export function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}
