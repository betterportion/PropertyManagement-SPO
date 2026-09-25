import { useQuery } from "@tanstack/react-query";

/**
 * The room names a house's walkthroughs know, for a `<datalist>`.
 *
 * The same route the maintenance location field reads, so "Bedroom 2" on a
 * resident and "Bedroom 2" on a walkthrough item are the same spelling and
 * the move-out worksheet can match them by `foldName`. Suggestions only: a
 * room no walkthrough has named can still be typed. Off until a house is
 * chosen, because there is nothing to ask about yet.
 */
export function useRoomSuggestions(propertyId: string | null | undefined): string[] {
  const { data = [] } = useQuery<string[]>({
    queryKey: ["/api/maintenance-locations", propertyId],
    queryFn: async () => {
      const response = await fetch(`/api/maintenance-locations?propertyId=${encodeURIComponent(propertyId!)}`, {
        credentials: "include",
      });
      if (!response.ok) return [];
      return await response.json();
    },
    enabled: !!propertyId,
  });
  return data;
}
