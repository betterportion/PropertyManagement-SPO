/** The query key for one resident's portal access. */
export function portalAccessKey(residentId: number | string): string {
  return `/api/residents/${residentId}/portal-access`;
}

/**
 * True for any resident's portal-access query. Each answer carries the whole
 * house's count, so a grant or removal on one resident has to refresh every
 * resident's card, or a housemate's card still shows a free place (#231).
 */
export function isPortalAccessQuery(query: { queryKey: readonly unknown[] }): boolean {
  const [first] = query.queryKey;
  return typeof first === "string" && first.startsWith("/api/residents/") && first.endsWith("/portal-access");
}
