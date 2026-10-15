import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Phone } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { serverMessage } from "@/lib/serverMessage";
import { REGIONS } from "@shared/regions";
import { EMERGENCY_LINE, SPO_PROPERTY_EMAIL } from "@shared/regionContacts";
import type { Property, RegionContact } from "@shared/schema";

const KEY = "/api/region-contacts";

type Draft = { name: string; phone: string; email: string; hours: string };
const EMPTY: Draft = { name: "", phone: "", email: "", hours: "" };

const draftOf = (row: RegionContact | undefined): Draft =>
  row ? { name: row.name, phone: row.phone, email: row.email ?? "", hours: row.hours ?? "" } : EMPTY;

/**
 * Who each region's households call for an urgent house problem (doc section
 * 1): the regional administrator's name and phone, one per region. Shown to
 * every household in that region on their Resources page, under SPO's 911
 * line, so it belongs beside the houses rather than in admin Settings: the
 * region's own RAs keep it current (doc 1.8), and admins can for any region.
 *
 * The regions listed are the ones the caller has houses in; the server scopes
 * both the list and the save by region.
 */
export default function RegionContacts() {
  const { toast } = useToast();
  const { user } = useAuth();
  const typedUser = user as { role?: string; permissions?: { canManageProperties?: boolean } } | null;
  const canEdit = typedUser?.role === "admin" || typedUser?.permissions?.canManageProperties === true;

  const { data: rows = [] } = useQuery<RegionContact[]>({ queryKey: [KEY] });
  const { data: properties = [] } = useQuery<Property[]>({ queryKey: ["/api/properties"] });
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});

  const regions = REGIONS.filter(
    (region) => properties.some((p) => p.region === region) || rows.some((r) => r.region === region),
  );
  const savedFor = (region: string) => rows.find((r) => r.region === region);

  // The draft is dropped only once the list has been re-read: dropping it
  // first shows the previous row (blank, on a first save) until the refetch
  // lands. Awaiting the invalidation also keeps the button in its pending
  // state until the fields show what was saved.
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: [KEY] });
    void queryClient.invalidateQueries({ queryKey: ["/api/my-property"] });
  };

  const save = useMutation({
    mutationFn: async ({ region, draft }: { region: string; draft: Draft }) =>
      await apiRequest("PUT", `${KEY}/${encodeURIComponent(region)}`, draft),
    onSuccess: async (_r, { region }) => {
      await invalidate();
      setDrafts(({ [region]: _done, ...rest }) => rest);
      toast({ title: `${region} saved` });
    },
    onError: (error) => toast({ title: "Not saved", description: serverMessage(error), variant: "destructive" }),
  });

  const clear = useMutation({
    mutationFn: async (region: string) => await apiRequest("DELETE", `${KEY}/${encodeURIComponent(region)}`),
    onSuccess: async (_r, region) => {
      await invalidate();
      setDrafts(({ [region]: _done, ...rest }) => rest);
      toast({ title: `${region} cleared` });
    },
    onError: (error) => toast({ title: "Not cleared", description: serverMessage(error), variant: "destructive" }),
  });

  if (regions.length === 0) return null;

  return (
    <Card id="region-contacts" data-testid="card-region-contacts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Phone className="h-5 w-5 text-muted-foreground" />
          Who your households call
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Every household in a region sees this on their Resources page, under the line "{EMERGENCY_LINE}" For urgent house
          problems: flooding, no heat, locked out. Non-urgent questions go to the email here, or to {SPO_PROPERTY_EMAIL} when
          it is blank.
        </p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y rounded-md border">
          {regions.map((region) => {
            const saved = savedFor(region);
            const draft = drafts[region] ?? draftOf(saved);
            const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
            const set = (field: keyof Draft, value: string) =>
              setDrafts((d) => ({ ...d, [region]: { ...(d[region] ?? draftOf(saved)), [field]: value } }));
            return (
              <li key={region} className="space-y-2 p-3" data-testid={`row-region-contact-${region}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{region}</span>
                  {!saved && <span className="text-xs text-muted-foreground">Not set: households are told to ask their RA</span>}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <Input
                    value={draft.name}
                    placeholder="Name"
                    aria-label={`${region} contact name`}
                    disabled={!canEdit}
                    onChange={(e) => set("name", e.target.value)}
                    data-testid={`input-region-contact-name-${region}`}
                  />
                  <Input
                    type="tel"
                    value={draft.phone}
                    placeholder="Phone"
                    aria-label={`${region} contact phone`}
                    disabled={!canEdit}
                    onChange={(e) => set("phone", e.target.value)}
                    data-testid={`input-region-contact-phone-${region}`}
                  />
                  <Input
                    type="email"
                    value={draft.email}
                    placeholder={`Email (blank: ${SPO_PROPERTY_EMAIL})`}
                    aria-label={`${region} contact email`}
                    disabled={!canEdit}
                    onChange={(e) => set("email", e.target.value)}
                    data-testid={`input-region-contact-email-${region}`}
                  />
                  <Input
                    value={draft.hours}
                    placeholder="Hours, e.g. 7 AM to 9 PM"
                    aria-label={`${region} contact hours`}
                    disabled={!canEdit}
                    onChange={(e) => set("hours", e.target.value)}
                    data-testid={`input-region-contact-hours-${region}`}
                  />
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!changed || save.isPending}
                      onClick={() => save.mutate({ region, draft })}
                      data-testid={`button-region-contact-save-${region}`}
                    >
                      Save
                    </Button>
                    {saved && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={clear.isPending}
                        onClick={() => clear.mutate(region)}
                        data-testid={`button-region-contact-clear-${region}`}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
