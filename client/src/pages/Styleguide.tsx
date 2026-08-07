import { useEffect, useState } from "react";
import { AlertTriangle, Inbox, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { EmptyState, ErrorState, LoadingState, StatPlaceholder } from "@/components/states";
import { PageHeader, PageStack } from "@/components/layout/page";
import { CHART_COLORS } from "@/lib/chart-palette";
import { formatCurrency, formatDate, formatPercent, formatValue } from "@/lib/format";
import { useTheme } from "@/providers/ThemeProvider";

/**
 * Internal design reference for the SPO design system.
 * Every color here is read from the live CSS variables, so this page can never
 * drift from the theme. Do not hardcode a hex value on this page.
 */

const SURFACE_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "muted",
  "muted-foreground",
  "border",
  "input",
  "ring",
];

const BRAND_TOKENS = [
  "primary",
  "primary-foreground",
  "primary-strong",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
];

const CHART_TOKENS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"];

function useTokenValues(tokens: string[]) {
  const { resolvedTheme } = useTheme();
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    const styles = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const token of tokens) {
      next[token] = styles.getPropertyValue(`--${token}`).trim();
    }
    setValues(next);
    // Re-read whenever the theme flips so the printed values stay honest.
  }, [tokens, resolvedTheme]);

  return values;
}

function Swatches({ title, tokens }: { title: string; tokens: string[] }) {
  const values = useTokenValues(tokens);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>Read live from the theme variables.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tokens.map((token) => (
          <div key={token} className="flex items-center gap-3">
            <div
              className="h-10 w-10 shrink-0 rounded-md border border-border"
              style={{ backgroundColor: `hsl(var(--${token}))` }}
            />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">--{token}</p>
              <p className="truncate text-xs text-muted-foreground tabular-nums">
                {values[token] || "—"}
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function Block({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

export default function Styleguide() {
  const { toast } = useToast();

  return (
    <PageStack>
      <PageHeader
        title="Style guide"
        description="The shared SPO look and feel: colors, type, controls and states. Build new screens from these."
      />

      <Swatches title="Surfaces and text" tokens={SURFACE_TOKENS} />
      <Swatches title="Brand and action" tokens={BRAND_TOKENS} />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Chart series</CardTitle>
          <CardDescription>
            Ordered series colors. Green means positive or on pace, amber means behind — never
            use those two as ordinary categories.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {CHART_COLORS.map((color, index) => (
            <div key={CHART_TOKENS[index]} className="flex items-center gap-2">
              <span
                className="h-8 w-8 rounded-md border border-border"
                style={{ backgroundColor: color }}
              />
              <span className="text-sm text-muted-foreground">--{CHART_TOKENS[index]}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Block title="Type scale" description="One family. Weight and size do the work; bold is not part of the system.">
        <h1 className="text-3xl font-semibold tracking-tight">Page title — text-3xl semibold</h1>
        <h2 className="text-2xl font-semibold tracking-tight">Card title — text-2xl semibold</h2>
        <h3 className="text-lg font-medium">Sub-heading — text-lg medium</h3>
        <p className="max-w-prose text-base leading-7">
          Body copy sits at text-base with relaxed line height and is capped at a readable
          measure. In light mode this is SPO navy, never pure black.
        </p>
        <p className="text-sm text-muted-foreground">Helper and meta text — text-sm muted</p>
        <p className="text-xs text-muted-foreground">Micro label — text-xs muted</p>
        <p className="text-2xl font-semibold tabular-nums">1,248 — stat value</p>
      </Block>

      <Block
        title="Buttons"
        description="Outlined red is the standard call to action. Solid red at rest is reserved for the single most important action on a page, and for destructive actions."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Default (outlined CTA)</Button>
          <Button variant="primary">Primary — one per page</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="link">Link</Button>
          <Button variant="destructive">Delete</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" aria-label="Add">
            <Plus />
          </Button>
          <Button disabled>Disabled</Button>
          <Button variant="primary">
            <Plus />
            With icon
          </Button>
        </div>
      </Block>

      <Block title="Badges" description="Badges carry status and always contain text, never color alone.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="outline">Outline</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="success">Completed</Badge>
          <Badge variant="warning">Awaiting parts</Badge>
          <Badge variant="info">In progress</Badge>
          <Badge variant="orange">Urgent</Badge>
        </div>
      </Block>

      <Block title="Form fields" description="Label, control, helper text. Errors change all three together.">
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sg-name">Property name</Label>
            <Input id="sg-name" placeholder="Riverside House" />
            <p className="text-sm text-muted-foreground">The name residents will recognize.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sg-email" className="text-destructive">Email</Label>
            <Input
              id="sg-email"
              defaultValue="not-an-email"
              className="border-destructive focus-visible:ring-destructive"
            />
            <p className="text-sm text-destructive">Please enter a valid email address.</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sg-select">Status</Label>
            <Select>
              <SelectTrigger id="sg-select">
                <SelectValue placeholder="Choose a status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="in_progress">In progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sg-notes">Notes</Label>
            <Textarea id="sg-notes" placeholder="Anything the maintenance team should know" />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sg-amount">Amount</Label>
            <Input id="sg-amount" type="number" placeholder="0.00" />
            <p className="text-sm text-muted-foreground">Number fields have no spinner arrows.</p>
          </div>
        </div>
      </Block>

      <Block title="Table" description="Numbers right-aligned, status as a badge, identity column linked.">
        <Table aria-label="Example invoices">
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead>Received</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>
                <a href="#" className="font-medium text-primary-strong hover:underline">
                  Northside Plumbing
                </a>
              </TableCell>
              <TableCell>{formatDate("2026-02-01")}</TableCell>
              <TableCell><Badge variant="success">Paid</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency("1245.5")}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell>
                <a href="#" className="font-medium text-primary-strong hover:underline">
                  Lakeside Electric
                </a>
              </TableCell>
              <TableCell>{formatDate(null)}</TableCell>
              <TableCell><Badge variant="warning">Awaiting approval</Badge></TableCell>
              <TableCell className="text-right tabular-nums">{formatCurrency(null)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Block>

      <Block title="Stat tiles" description="Label above value. While loading, the value is a dash — never a spinner or a zero.">
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardDescription>Open requests</CardDescription>
              <CardTitle className="text-2xl tabular-nums">12</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardDescription>Loading</CardDescription>
              <CardTitle className="text-2xl"><StatPlaceholder /></CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardDescription>Spend this month</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{formatCurrency(18240)}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-4 pb-2">
              <CardDescription>Walkthroughs complete</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{formatPercent(82)}</CardTitle>
            </CardHeader>
          </Card>
        </div>
      </Block>

      <Block title="States" description="Loading, empty and error look the same on every page.">
        <LoadingState className="h-32" />
        <EmptyState
          icon={Inbox}
          title="No open requests"
          description="Everything reported so far has been resolved. New requests will appear here."
          action={<Button size="sm">Submit a request</Button>}
        />
        <ErrorState onRetry={() => undefined} />
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            onClick={() => toast({ title: "Saved", description: "Your changes are live" })}
          >
            Show a toast
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              toast({
                variant: "destructive",
                title: "Could not save",
                description: "Check your connection and try again",
              })
            }
          >
            Show an error toast
          </Button>
        </div>
      </Block>

      <Block title="Card anatomy" description="Cards are bordered, never shadowed. Shadows belong to floating layers only.">
        <Card>
          <CardHeader>
            <CardTitle>Riverside House</CardTitle>
            <CardDescription>12 rooms · Saint Paul, MN</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>Missing values render as an em-dash: {formatValue(null)}</p>
            <p className="text-muted-foreground">
              Cards are the default container for a discrete unit of content.
            </p>
          </CardContent>
          <CardFooter className="gap-2">
            <Button size="sm">View details</Button>
            <Button size="sm" variant="ghost">Dismiss</Button>
          </CardFooter>
        </Card>
      </Block>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Things that count as drift</CardTitle>
          <CardDescription>If you spot these in a screen, it has fallen out of the system.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {[
              "font-bold anywhere — the system stops at semibold",
              "Pure black or plain gray text instead of the navy foreground token",
              "rounded-full on a button or input",
              "A shadow on a card to make it stand out",
              '"No data" as empty-state copy',
              "A hardcoded hex color instead of a token",
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-primary-strong" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </PageStack>
  );
}
