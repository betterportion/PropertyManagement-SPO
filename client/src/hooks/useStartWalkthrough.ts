import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";

import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Walkthrough } from "@shared/schema";

/**
 * Starting a walkthrough, shared by the two indexes that can start one.
 *
 * `Walkthroughs.tsx` (staff, any house they cover) and `MyWalkthroughs.tsx`
 * (a household leader, their own) are deliberately separate screens, but the
 * act of starting is one thing: the same request, the same cache to
 * invalidate, the same "the checklist came back empty" warning, and the same
 * jump into the new walkthrough. Two copies of that is how the toast on one
 * screen drifts from the toast on the other.
 *
 * Which house may be started is not decided here — the server checks that,
 * by region for staff and by their own address for a leader.
 */

/** Today as "YYYY-MM-DD", for a date input's default. */
export function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export interface StartWalkthroughInput {
  propertyId: string;
  type: Walkthrough["type"];
  walkthroughDate: string;
}

export function useStartWalkthrough(onStarted?: () => void) {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (input: StartWalkthroughInput) => {
      const response = await apiRequest("POST", "/api/walkthroughs", input);
      return (await response.json()) as Walkthrough & { roomsCreated: number };
    },
    onSuccess: (walkthrough) => {
      // staleTime is Infinity and nothing refetches on its own, so the index
      // behind us only shows the new walkthrough if we invalidate here.
      queryClient.invalidateQueries({ queryKey: ["/api/walkthroughs"] });
      onStarted?.();
      if (walkthrough.roomsCreated === 0) {
        toast({
          title: "Walkthrough started, but the checklist is empty",
          description: "The standard rooms did not load. Add the rooms you need from inside the walkthrough.",
        });
      }
      navigate(`/walkthroughs/${walkthrough.id}`);
    },
    onError: () => {
      toast({ variant: "destructive", title: "Not started", description: "The walkthrough could not be started." });
    },
  });
}
