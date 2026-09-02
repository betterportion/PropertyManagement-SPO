import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowLeft, Building2, CalendarDays, ChevronRight, ClipboardList, MapPin, Plus, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useAuth } from "@/hooks/useAuth";
import { today, useStartWalkthrough } from "@/hooks/useStartWalkthrough";
import { formatDate } from "@/lib/format";
import {
  WALKTHROUGH_STATUS_BADGE,
  WALKTHROUGH_TYPE_LABEL,
  canFillInWalkthroughs,
  type WalkthroughUser,
} from "@/lib/walkthrough";
import type { Property, Walkthrough } from "@shared/schema";

/**
 * Which houses have been walked, and when.
 *
 * This page is the index; the filling-in happens on `/walkthroughs/:id`.
 * Rooms used to hang straight off a property and this page listed them, which
 * meant a house had exactly one set of rooms and no history. A walkthrough is
 * now a dated event, so the list a house shows is a list of visits.
 */

/** Legacy walkthroughs came from the backfill; nobody starts one. */
const STARTABLE_TYPES: Walkthrough["type"][] = ["annual", "move_in", "move_out"];

export default function Walkthroughs() {
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const [selectedProperty, setSelectedProperty] = useState<Property | null>(null);
  const [isStartOpen, setIsStartOpen] = useState(false);
  const [newType, setNewType] = useState<Walkthrough["type"]>("annual");
  const [newDate, setNewDate] = useState(today());

  // Computed, not returned on. An early return above the queries below would
  // change the hook count once the auth query resolves, and React throws.
  const canManage = canFillInWalkthroughs(user as WalkthroughUser | null);

  const { data: properties = [], isLoading: propertiesLoading } = useQuery<Property[]>({
    queryKey: ["/api/properties"],
  });

  const { data: walkthroughs = [], isLoading: walkthroughsLoading } = useQuery<Walkthrough[]>({
    queryKey: ["/api/walkthroughs"],
  });

  const byProperty = useMemo(() => {
    const grouped = new Map<string, Walkthrough[]>();
    for (const walkthrough of walkthroughs) {
      const existing = grouped.get(walkthrough.propertyId);
      if (existing) existing.push(walkthrough);
      else grouped.set(walkthrough.propertyId, [walkthrough]);
    }
    for (const group of Array.from(grouped.values())) {
      group.sort(
        (a: Walkthrough, b: Walkthrough) =>
          new Date(b.walkthroughDate).getTime() - new Date(a.walkthroughDate).getTime(),
      );
    }
    return grouped;
  }, [walkthroughs]);

  const startWalkthrough = useStartWalkthrough(() => setIsStartOpen(false));

  const isLoading = propertiesLoading || walkthroughsLoading;
  const propertyWalkthroughs = selectedProperty ? (byProperty.get(selectedProperty.id) ?? []) : [];

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title={selectedProperty ? selectedProperty.name : "Walkthroughs"}
            description={
              selectedProperty
                ? selectedProperty.address
                : "Pick a house to see its inspections, or start a new one."
            }
            actions={
              <>
                <Button
                  variant="secondary"
                  onClick={() => navigate("/walkthroughs/flagged")}
                  data-testid="button-flagged-items"
                >
                  <TriangleAlert className="h-4 w-4" />
                  Needs attention
                </Button>
                {selectedProperty && (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelectedProperty(null)}
                    aria-label="Back to properties"
                    data-testid="button-back-to-properties"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                )}
                {selectedProperty && canManage && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setNewType("annual");
                      setNewDate(today());
                      setIsStartOpen(true);
                    }}
                    data-testid="button-start-walkthrough"
                  >
                    <Plus className="h-4 w-4" />
                    Start a walkthrough
                  </Button>
                )}
              </>
            }
          />

          {isLoading ? (
            <LoadingState message="Loading walkthroughs..." />
          ) : !selectedProperty ? (
            properties.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No properties are ready for walkthroughs"
                description="Add a property first, then every inspection of that house is recorded here."
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {properties.map((property) => {
                  const history = byProperty.get(property.id) ?? [];
                  const latest = history[0];
                  return (
                    <Card
                      key={property.id}
                      className="cursor-pointer hover-elevate active-elevate-2"
                      onClick={() => setSelectedProperty(property)}
                      data-testid={`card-property-${property.id}`}
                    >
                      <CardContent className="p-5">
                        <div className="flex items-start gap-3">
                          <div className="flex-shrink-0 rounded-md bg-muted p-2">
                            <Building2 className="h-5 w-5 text-muted-foreground" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-base font-semibold" data-testid={`text-property-name-${property.id}`}>
                              {property.name}
                            </h3>
                            <div className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
                              <MapPin className="h-3 w-3 flex-shrink-0" />
                              <span className="truncate">{property.address}</span>
                            </div>
                          </div>
                        </div>
                        <div className="mt-4 flex items-center gap-2">
                          {property.region && (
                            <Badge variant="secondary" className="text-xs">
                              {property.region}
                            </Badge>
                          )}
                          <span className="ml-auto text-xs text-muted-foreground" data-testid={`text-last-walkthrough-${property.id}`}>
                            {latest
                              ? `Last walked ${formatDate(latest.walkthroughDate)}`
                              : "Never walked"}
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )
          ) : propertyWalkthroughs.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="This house has not been walked yet"
              description="The first walkthrough starts from the standard checklist, and every one after copies this house's own last visit."
              action={
                canManage ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setNewType("annual");
                      setNewDate(today());
                      setIsStartOpen(true);
                    }}
                    data-testid="button-start-first-walkthrough"
                  >
                    <Plus className="h-4 w-4" />
                    Start the first walkthrough
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-3">
              {propertyWalkthroughs.map((walkthrough) => {
                const status = WALKTHROUGH_STATUS_BADGE[walkthrough.status];
                return (
                  <Card
                    key={walkthrough.id}
                    className="cursor-pointer hover-elevate active-elevate-2"
                    onClick={() => navigate(`/walkthroughs/${walkthrough.id}`)}
                    data-testid={`card-walkthrough-${walkthrough.id}`}
                  >
                    <CardContent className="flex items-center gap-3 p-4">
                      <div className="flex-shrink-0 rounded-md bg-muted p-2">
                        <CalendarDays className="h-5 w-5 text-muted-foreground" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold" data-testid={`text-walkthrough-date-${walkthrough.id}`}>
                          {formatDate(walkthrough.walkthroughDate)}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                          {WALKTHROUGH_TYPE_LABEL[walkthrough.type]}
                          {walkthrough.performedBy ? ` · ${walkthrough.performedBy}` : ""}
                        </p>
                      </div>
                      <Badge variant={status.variant} data-testid={`badge-status-${walkthrough.id}`}>
                        {status.label}
                      </Badge>
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}

          <Dialog open={isStartOpen} onOpenChange={setIsStartOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Start a walkthrough</DialogTitle>
                <DialogDescription>
                  {selectedProperty?.name} — {selectedProperty?.address}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="walkthrough-type">Kind of walkthrough</Label>
                  <Select value={newType} onValueChange={(value) => setNewType(value as Walkthrough["type"])}>
                    <SelectTrigger id="walkthrough-type" data-testid="select-walkthrough-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {STARTABLE_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {WALKTHROUGH_TYPE_LABEL[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="walkthrough-date">Date</Label>
                  <Input
                    id="walkthrough-date"
                    type="date"
                    value={newDate}
                    onChange={(event) => setNewDate(event.target.value)}
                    data-testid="input-walkthrough-date"
                  />
                </div>
              </div>

              <DialogFooter>
                <Button variant="secondary" onClick={() => setIsStartOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!selectedProperty || !newDate || startWalkthrough.isPending}
                  onClick={() =>
                    selectedProperty &&
                    startWalkthrough.mutate({
                      propertyId: selectedProperty.id,
                      type: newType,
                      walkthroughDate: newDate,
                    })
                  }
                  data-testid="button-confirm-start-walkthrough"
                >
                  {startWalkthrough.isPending ? "Starting…" : "Start"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </PageStack>
      </Container>
    </Section>
  );
}
