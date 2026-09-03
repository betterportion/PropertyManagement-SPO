import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/components/states";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { REGIONS } from "@shared/regions";
import type { ResourceLink } from "@shared/schema";

/**
 * What SPO publishes to its household leaders and stewards.
 *
 * **Admin-only, like the walkthrough template and for the same reason:** a
 * national link reaches every region, so editing one is not a grant over your
 * own houses. A link can be scoped to a region, which is what lets one region
 * publish its own guidance without it reaching the rest.
 *
 * These are **links, never documents.** Most of the content lives on Drive,
 * and duplicating a deep-clean checklist into the portal means two copies that
 * disagree within a term.
 */

/** The "everybody" option; a Select cannot carry null. */
const NATIONAL = "__national__";

/** Suggested groupings. Free text underneath, so SPO can add their own. */
const CATEGORIES = ["General", "Housekeeping", "Safety", "Money", "Paperwork"];

export default function ResourceLinksSettings() {
  const { toast } = useToast();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("General");
  const [region, setRegion] = useState(NATIONAL);

  const { data: links = [], isLoading } = useQuery<ResourceLink[]>({
    queryKey: ["/api/resource-links"],
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/resource-links"] });

  const add = useMutation({
    mutationFn: async () =>
      await apiRequest("POST", "/api/resource-links", {
        title,
        url,
        description: description || null,
        category,
        region: region === NATIONAL ? null : region,
      }),
    onSuccess: () => {
      invalidate();
      setTitle("");
      setUrl("");
      setDescription("");
    },
    onError: () => {
      toast({
        title: "That link was not added",
        description: "Check the address starts with https:// and try again.",
        variant: "destructive",
      });
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => await apiRequest("DELETE", `/api/resource-links/${id}`),
    onSuccess: invalidate,
    onError: () => toast({ title: "That link was not removed", variant: "destructive" }),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>What households see</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <p className="text-sm text-muted-foreground">
          These appear on every household leader and steward's Resources page. Keep the documents
          themselves on Drive and link to them here — two copies disagree within a term.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="link-title">Name</Label>
            <Input
              id="link-title"
              value={title}
              maxLength={200}
              placeholder="e.g. Deep clean checklist"
              onChange={(event) => setTitle(event.target.value)}
              data-testid="input-resource-title"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="link-url">Address</Label>
            <Input
              id="link-url"
              type="url"
              value={url}
              placeholder="https://drive.google.com/..."
              onChange={(event) => setUrl(event.target.value)}
              data-testid="input-resource-url"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="link-category">Group</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger id="link-category" data-testid="select-resource-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="link-region">Who sees it</Label>
            <Select value={region} onValueChange={setRegion}>
              <SelectTrigger id="link-region" data-testid="select-resource-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NATIONAL}>Every region</SelectItem>
                {REGIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option} only
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="link-description">One line about it (optional)</Label>
            <Input
              id="link-description"
              value={description}
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              data-testid="input-resource-description"
            />
          </div>
        </div>

        <Button
          variant="primary"
          disabled={title.trim().length === 0 || url.trim().length === 0 || add.isPending}
          onClick={() => add.mutate()}
          data-testid="button-add-resource-link"
        >
          <Plus className="h-4 w-4" />
          {add.isPending ? "Adding…" : "Add link"}
        </Button>

        {isLoading ? (
          <LoadingState message="Loading links..." />
        ) : links.length === 0 ? (
          <EmptyState
            title="Nothing is published yet"
            description="The house expectations, the deep clean checklist and the safety guidance are the ones households ask for first."
          />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex items-start gap-3 p-3"
                data-testid={`row-resource-${link.id}`}
              >
                <span className="min-w-0 flex-1">
                  <a
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                    href={link.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {link.title}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  {link.description && (
                    <span className="block text-sm text-muted-foreground">{link.description}</span>
                  )}
                </span>
                <Badge variant="secondary" className="shrink-0">
                  {link.category}
                </Badge>
                <Badge variant={link.region ? "outline" : "secondary"} className="shrink-0">
                  {link.region ?? "Every region"}
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${link.title}`}
                  onClick={() => remove.mutate(link.id)}
                  data-testid={`button-remove-resource-${link.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
