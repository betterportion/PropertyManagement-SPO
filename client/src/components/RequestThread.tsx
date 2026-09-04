import { useState } from "react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Lock, MessageSquare, Trash2, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { formatDateTime } from "@/lib/format";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { MaintenanceContact, MaintenanceRequestComment } from "@shared/schema";

/**
 * The thread on a request.
 *
 * What the server sends is what is shown: a household gets the shared half
 * because the list route filtered it, not because anything here hides the
 * rest. The composer is staff's -- a household reads for now (#120 adds
 * their composer) -- and it opens on Internal every time, because the
 * comment that goes wrong is "he quoted $4,200" pasted into a repair thread
 * with Shared left on from last time.
 */

interface RequestThreadProps {
  requestId: string;
  /**
   * Owned by the page, not this component, so it starts alongside the request
   * and the photos rather than after the request has resolved -- the same
   * reason the contractors query lives up there.
   */
  commentsQuery: UseQueryResult<MaintenanceRequestComment[]>;
  /** Whether the reader is staff: the composer, the Internal badge and the relay controls are theirs. */
  isStaff: boolean;
  isAdmin: boolean;
  currentUserId: string | null;
}

/** "Sarah Lee", or the email when the account had no name, or a placeholder after the account went. */
function authorLabel(comment: MaintenanceRequestComment): string {
  return comment.authorName || comment.authorEmail || "A former user";
}

/**
 * Mirrors canDeleteComment on the server: the author, or an admin. Offered as
 * a button only where the request would succeed.
 */
function canDelete(comment: MaintenanceRequestComment, currentUserId: string | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!currentUserId && comment.authorUserId === currentUserId;
}

const NO_CONTACT = "none";

export default function RequestThread({ requestId, commentsQuery, isStaff, isAdmin, currentUserId }: RequestThreadProps) {
  const { toast } = useToast();
  const commentsKey = ["/api/maintenance-requests", requestId, "comments"];

  const [body, setBody] = useState("");
  const [isInternal, setIsInternal] = useState(true);
  const [isRelayed, setIsRelayed] = useState(false);
  const [relaySource, setRelaySource] = useState("");
  const [relayContactId, setRelayContactId] = useState(NO_CONTACT);

  // Only fetched once somebody says a comment is relayed; a household never
  // reaches this list and staff rarely need it.
  const contactsQuery = useQuery<MaintenanceContact[]>({
    queryKey: ["/api/contacts"],
    enabled: isStaff && isRelayed,
  });

  const postComment = useMutation({
    mutationFn: async () =>
      apiRequest("POST", `/api/maintenance-requests/${requestId}/comments`, {
        body,
        isInternal,
        relaySource: isRelayed ? relaySource : null,
        relayContactId: isRelayed && relayContactId !== NO_CONTACT ? relayContactId : null,
      }),
    onSuccess: () => {
      // The thread's own key and nothing else: the request did not change.
      queryClient.invalidateQueries({ queryKey: commentsKey });
      setBody("");
      setIsRelayed(false);
      setRelaySource("");
      setRelayContactId(NO_CONTACT);
      // Back to Internal, deliberately: the default is per comment, not per visit.
      setIsInternal(true);
    },
    onError: (error: Error) => {
      toast({ title: "The comment was not posted", description: error.message, variant: "destructive" });
    },
  });

  const deleteComment = useMutation({
    mutationFn: async (commentId: string) => apiRequest("DELETE", `/api/maintenance-request-comments/${commentId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: commentsKey }),
    onError: (error: Error) => {
      toast({ title: "The comment was not deleted", description: error.message, variant: "destructive" });
    },
  });

  const comments = commentsQuery.data ?? [];
  const canPost = body.trim().length > 0 && (!isRelayed || relaySource.trim().length > 0) && !postComment.isPending;

  return (
    <Card data-testid="request-thread">
      <CardHeader>
        <CardTitle>Thread</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {commentsQuery.isLoading ? (
          <LoadingState message="Loading the thread..." className="h-24" />
        ) : commentsQuery.isError ? (
          <ErrorState message="The thread could not be loaded." onRetry={() => commentsQuery.refetch()} />
        ) : comments.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="Nothing in the thread yet"
            description={
              isStaff
                ? "Who is coming, when, what they found, what it cost -- put it here instead of in a text message."
                : "Updates from the property team about this request will appear here."
            }
          />
        ) : (
          <ol className="space-y-4" data-testid="list-comments">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded-md border border-border p-3 text-sm" data-testid={`comment-${comment.id}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium" data-testid={`comment-author-${comment.id}`}>
                      {authorLabel(comment)}
                      {/* A relayed comment is the contractor's words in the RA's hand. */}
                      {comment.relaySource && (
                        <span className="font-normal text-muted-foreground">, relaying {comment.relaySource}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(comment.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isStaff && (
                      <Badge variant={comment.isInternal ? "secondary" : "outline"} data-testid={`comment-visibility-${comment.id}`}>
                        {comment.isInternal ? <Lock className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                        {comment.isInternal ? "Internal" : "Shared"}
                      </Badge>
                    )}
                    {canDelete(comment, currentUserId, isAdmin) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Delete comment"
                        disabled={deleteComment.isPending}
                        onClick={() => deleteComment.mutate(comment.id)}
                        data-testid={`button-delete-comment-${comment.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-2 whitespace-pre-line" data-testid={`comment-body-${comment.id}`}>
                  {comment.body}
                </p>
              </li>
            ))}
          </ol>
        )}

        {isStaff && (
          <form
            className="space-y-4 border-t border-border pt-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (canPost) postComment.mutate();
            }}
            data-testid="form-comment"
          >
            {/* Two buttons, not a checkbox: the current visibility has to be
                readable at a glance, because the wrong one is discovered by a
                student. */}
            <div className="space-y-2">
              <Label>Who sees this comment</Label>
              <div className="inline-flex rounded-md border border-border p-0.5" role="group" aria-label="Who sees this comment">
                <Button
                  type="button"
                  size="sm"
                  variant={isInternal ? "primary" : "ghost"}
                  aria-pressed={isInternal}
                  onClick={() => setIsInternal(true)}
                  data-testid="button-visibility-internal"
                >
                  <Lock className="h-3.5 w-3.5" />
                  Internal
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={isInternal ? "ghost" : "primary"}
                  aria-pressed={!isInternal}
                  onClick={() => setIsInternal(false)}
                  data-testid="button-visibility-shared"
                >
                  <Users className="h-3.5 w-3.5" />
                  Shared
                </Button>
              </div>
              <p className="text-xs text-muted-foreground" data-testid="text-visibility-explainer">
                {isInternal
                  ? "Staff only. The household will not see this."
                  : "The household leader and steward for this house will see this."}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="comment-body">Comment</Label>
              <Textarea
                id="comment-body"
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={4}
                maxLength={4000}
                placeholder={isInternal ? "What did the contractor say? What did it cost?" : "What does the household need to know?"}
                data-testid="input-comment-body"
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch id="comment-relayed" checked={isRelayed} onCheckedChange={setIsRelayed} data-testid="switch-comment-relayed" />
              <Label htmlFor="comment-relayed">Relaying somebody else's words</Label>
            </div>

            {isRelayed && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="comment-relay-source">Who said it</Label>
                  <Input
                    id="comment-relay-source"
                    value={relaySource}
                    onChange={(event) => setRelaySource(event.target.value)}
                    maxLength={120}
                    placeholder="Dave (handyman)"
                    data-testid="input-relay-source"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="comment-relay-contact">Their contact record, if they have one</Label>
                  <Select value={relayContactId} onValueChange={setRelayContactId}>
                    <SelectTrigger id="comment-relay-contact" data-testid="select-relay-contact">
                      <SelectValue placeholder="Not on the contacts list" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_CONTACT}>Not on the contacts list</SelectItem>
                      {(contactsQuery.data ?? []).map((contact) => (
                        <SelectItem key={contact.id} value={contact.id}>
                          {contact.name} · {contact.company}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" variant="primary" disabled={!canPost} data-testid="button-post-comment">
                {postComment.isPending ? "Posting..." : isInternal ? "Post internal comment" : "Share with the household"}
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
