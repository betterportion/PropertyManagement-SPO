import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import type { DepositReturnRule, Property } from "@shared/schema";

const KEY = "/api/deposit-return-rules";

/**
 * How many days after a move-out each state allows to return a deposit.
 *
 * Admins only, and empty until SPO confirms each state's rule: the portal
 * ships with no legal figures. A house's own number (on the property's lease
 * settings) overrides its state's. Days are counted from the move-out date.
 */
export default function DepositDeadlineSettings() {
  const { toast } = useToast();
  const { data: rules = [] } = useQuery<DepositReturnRule[]>({ queryKey: [KEY] });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // The states SPO has houses in, plus any with a rule already.
  const states = Array.from(
    new Set([...properties.map((p) => p.state?.trim().toUpperCase()).filter((s): s is string => !!s && /^[A-Z]{2}$/.test(s)), ...rules.map((r) => r.state)]),
  ).sort();
  const daysFor = (state: string) => rules.find((r) => r.state === state)?.days ?? null;

  const save = useMutation({
    mutationFn: async ({ state, days }: { state: string; days: number | null }) => await apiRequest("PUT", `${KEY}/${state}`, { days }),
    onSuccess: (_r, { state }) => {
      setDrafts(({ [state]: _done, ...rest }) => rest);
      queryClient.invalidateQueries({ queryKey: [KEY] });
      queryClient.invalidateQueries({ queryKey: ["/api/action-items"] });
      toast({ title: `${state} saved` });
    },
    onError: (error) => toast({ title: "Not saved", description: serverMessage(error), variant: "destructive" }),
  });

  return (
    <Card id="deposit-deadlines" data-testid="card-deposit-deadlines">
      <CardHeader>
        <CardTitle>Deposit return deadlines</CardTitle>
        <p className="text-sm text-muted-foreground">
          Days after a move-out to return a deposit, for each state SPO has houses in. Enter the figure SPO has confirmed for
          each state; the portal has none built in. A house's own number, on its lease settings, overrides its state's. Leave a
          state blank and its deposits are still flagged, just without a deadline.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {states.map((state) => {
            const saved = daysFor(state);
            const draft = drafts[state] ?? (saved === null ? "" : String(saved));
            const changed = draft !== (saved === null ? "" : String(saved));
            return (
              <li key={state} className="flex flex-wrap items-center gap-3 p-3" data-testid={`row-deposit-rule-${state}`}>
                <span className="w-10 font-medium">{state}</span>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  className="w-28"
                  value={draft}
                  placeholder="Not set"
                  aria-label={`${state} return days`}
                  onChange={(e) => setDrafts((d) => ({ ...d, [state]: e.target.value }))}
                  data-testid={`input-deposit-rule-${state}`}
                />
                <span className="text-sm text-muted-foreground">days</span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!changed || save.isPending}
                  onClick={() => save.mutate({ state, days: draft.trim() === "" ? null : Number(draft) })}
                  data-testid={`button-deposit-rule-${state}`}
                >
                  Save
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
