import { ChevronRight, Compass } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * A short guide for SPO national staff: what the portal is for and where each
 * job lives. Static words only; it changes nothing. Keep each topic to a few
 * lines and name screens exactly as the sidebar and buttons do.
 */
const TOPICS: { title: string; points: string[] }[] = [
  {
    title: "Your weekly check",
    points: [
      "Dashboard shows each region with its regional administrator (RA). Regions that need attention come first.",
      "Each region card counts overdue safety checks, open repairs, leases due for renewal and households behind on HH fees. Select a region to see the houses behind the numbers.",
      "Tasks holds the reminders the portal raises on its own (walkthrough season, utilities, the winter-break check-in) and any you add for an RA.",
    ],
  },
  {
    title: "Set up a region",
    points: [
      "Settings, People tab: Add User for the RA, role Regional Admin, then Permissions to tick their region and what they may do.",
      "Properties: check each house's details.",
      "Residents: Import a roster for each house from a spreadsheet.",
      "On a resident's page, Portal access lets up to 4 people per house sign in (the household leader and stewards), with the Google email on the roster.",
      "Settings, Portal setup tab: \"What households see\" holds the links every household gets on its Resources page.",
    ],
  },
  {
    title: "Repairs",
    points: [
      "Households report a repair from their phone with photos. It appears on Maintenance for the RA.",
      "The RA moves it along, links a contractor from Maintenance Contacts & Invoices, and keeps the conversation on the request. Notes are staff only unless marked Shared.",
      "Completing a repair asks how the contractor did, so the next RA can see who to call again.",
    ],
  },
  {
    title: "Walkthroughs and assets",
    points: [
      "Walkthroughs records each house room by room at move-in and move-out, with photos. A household leader can complete their own house's on a phone.",
      "Anything flagged can be sent to Maintenance as a repair. Prior years stay on file for comparison.",
      "Assets tracks appliances and equipment and raises a replacement when one reaches the end of its life.",
    ],
  },
  {
    title: "Money",
    points: [
      "Finances shows what is outstanding, HH fees by house and each resident's deposit.",
      "QuickBooks and Ramp move the money. The portal keeps references, amounts and dates only, and refuses bank or card numbers.",
      "Set each state's deposit return deadline in Settings, Portal setup tab, so a held deposit is raised in time.",
    ],
  },
  {
    title: "Keeping watch",
    points: [
      "The activity log, on the Activity tab, records access, money and document changes, with who and when.",
      "Email health, on the same tab, shows whether the portal's emails are going out.",
      "Records are never deleted when someone moves out. Their login closes when they leave the roster.",
    ],
  },
];

export function AdminGuide() {
  return (
    <Card data-testid="card-admin-guide">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Compass className="h-5 w-5" aria-hidden />
          How to run the portal
        </CardTitle>
        <CardDescription>
          One place for SPO's houses and the RAs who look after them. Each RA runs their own region; national staff see every region and keep it on track.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {TOPICS.map((topic) => (
          <details key={topic.title} className="group py-3 first:pt-0 last:pb-0" data-testid={`guide-${topic.title.toLowerCase().replace(/\s+/g, "-")}`}>
            <summary className="flex cursor-pointer list-none items-center gap-2 font-medium transition-colors hover:text-primary [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-4 w-4 shrink-0 transition-transform duration-200 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
              {topic.title}
            </summary>
            <ul className="mt-2 list-disc space-y-1 pl-10 sm:pl-12 text-sm text-muted-foreground">
              {topic.points.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}
