import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CalendarDays, ChevronRight, ClipboardList, Plus } from "lucide-react";

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
import { Container, PageHeader, PageStack, Section } from "@/components/layout/page";
import { EmptyState, LoadingState } from "@/components/states";
import { useAuth } from "@/hooks/useAuth";
import { today, useStartWalkthrough } from "@/hooks/useStartWalkthrough";
import { formatDate } from "@/lib/format";
import {
  WALKTHROUGH_STATUS_BADGE,
  WALKTHROUGH_TYPE_LABEL,
  canFillInWalkthroughs,
  isCurrentWalkthrough,
  type WalkthroughUser,
} from "@/lib/walkthrough";
import type { Walkthrough } from "@shared/schema";

/**
 * The walkthrough index a household leader or steward sees.
 *
 * Separate from the staff `Walkthroughs` page rather than a role branch inside
 * it, because the two are different screens: staff pick a house out of every
 * house they cover, and a leader has exactly one. There is no house picker
 * here and no `/api/properties` call behind it -- a resident account cannot
 * read that list, and asking them to choose from a list of one would be a
 * step that only ever has one answer.
 *
 * What comes back from `/api/walkthroughs` is already only their house: the
 * server filters a resident by the address their login is linked to. This page
 * shows what it is given and never filters again, so the two cannot drift.
 */

/** A leader starts the annual inspection; move-in and move-out are staff events. */
const RESIDENT_WALKTHROUGH_TYPE: Walkthrough["type"] = "annual";

export default function MyWalkthroughs() {
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const [isStartOpen, setIsStartOpen] = useState(false);
  const [newDate, setNewDate] = useState(today());

  const typedUser = user as WalkthroughUser | null;

  // Computed, never returned on: a guard above the query below would change
  // the hook count the moment the auth query resolves, and React throws.
  const canComplete = canFillInWalkthroughs(typedUser);
  const propertyId = typedUser?.propertyId ?? null;

  const { data: walkthroughs = [], isLoading } = useQuery<Walkthrough[]>({
    queryKey: ["/api/walkthroughs"],
    enabled: canComplete,
  });

  // Newest first: the one being filled in now is the one they came for.
  const history = [...walkthroughs].sort(
    (a, b) => new Date(b.walkthroughDate).getTime() - new Date(a.walkthroughDate).getTime(),
  );

  const startWalkthrough = useStartWalkthrough(() => setIsStartOpen(false));

  let body: React.ReactNode;
  if (!canComplete) {
    body = (
      <EmptyState
        icon={ClipboardList}
        title="Walkthroughs are not switched on for your account"
        description="Ask your regional administrator to give your account permission to complete walkthroughs."
      />
    );
  } else if (!propertyId) {
    body = (
      <EmptyState
        icon={ClipboardList}
        title="Your account is not linked to a house yet"
        description="A walkthrough belongs to one house, so nothing can be shown until your account is linked to yours. Ask your regional administrator to link it."
      />
    );
  } else if (isLoading) {
    body = <LoadingState message="Loading your walkthroughs..." />;
  } else if (history.length === 0) {
    body = (
      <EmptyState
        icon={ClipboardList}
        title="Your house has not been walked yet"
        description="The first walkthrough starts from the standard checklist. Go room by room, and remove anything your house does not have."
        action={
          <Button
            variant="primary"
            onClick={() => {
              setNewDate(today());
              setIsStartOpen(true);
            }}
            data-testid="button-start-first-walkthrough"
          >
            <Plus className="h-4 w-4" />
            Start the first walkthrough
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="space-y-3">
        {history.map((walkthrough) => {
          const status = WALKTHROUGH_STATUS_BADGE[walkthrough.status];
          // Prior years open read-only, so the list says which is which
          // rather than letting somebody find out by tapping a chip that
          // will not stick.
          const writable = isCurrentWalkthrough(walkthrough, history);
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
                    {writable ? "" : " · view only"}
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
    );
  }

  return (
    <Section size="compact">
      <Container>
        <PageStack>
          <PageHeader
            title="Walkthroughs"
            description="Every inspection of your house, newest first. Open one to fill it in."
            actions={
              canComplete && propertyId && history.length > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => {
                    setNewDate(today());
                    setIsStartOpen(true);
                  }}
                  data-testid="button-start-walkthrough"
                >
                  <Plus className="h-4 w-4" />
                  Start a walkthrough
                </Button>
              ) : undefined
            }
          />

          {body}

          <Dialog open={isStartOpen} onOpenChange={setIsStartOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Start a walkthrough</DialogTitle>
                <DialogDescription>
                  This starts a new inspection of your house. Last year's is kept as it was.
                </DialogDescription>
              </DialogHeader>

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

              <DialogFooter>
                <Button variant="secondary" onClick={() => setIsStartOpen(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!newDate || startWalkthrough.isPending}
                  onClick={() =>
                    propertyId &&
                    startWalkthrough.mutate({
                      propertyId,
                      type: RESIDENT_WALKTHROUGH_TYPE,
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
